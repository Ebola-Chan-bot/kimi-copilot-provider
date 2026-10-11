import * as vscode from "vscode";
import {
	KimiApiClient,
	KimiApiError,
	summarizeErrorResponse,
} from "./api.js";
import { getApiBaseUrl, getReasoningEffort } from "./config.js";
import { toLanguageModelChatInformation, getModelTokenBudget, type KimiModelInfo } from "./models.js";
import { accountId, ModelCatalog } from "./catalog.js";
import type { Account } from "./usage.js";
import { parseTokenUsage, type TokenUsage } from "./tokenUsage.js";
import { convertMessages, convertTools } from "./messages.js";
import {
	getApiKey,
	getPromptCacheKey,
	hasProviderConfiguration,
	readStringOption,
	type KimiResponseOptions,
} from "./requestOptions.js";
import { createThinkingPart } from "./thinking.js";
import { estimateTokenCount } from "./tokenCount.js";
import { ToolCallAccumulator } from "./toolCalls.js";

function mapKimiApiError(error: KimiApiError): Error {
	const detail = error.response
		? ` Response: ${summarizeErrorResponse(error.response)}`
		: "";

	switch (error.statusCode) {
		case 0:
			return new Error(`${error.message}${detail}`);
		case 401:
			return new Error(vscode.l10n.t(
				"Authentication failed (401). Check your API key from kimi.com/code/console.{0}", detail,
			));
		case 403:
			return new Error(vscode.l10n.t("Forbidden (403). The API rejected the request.{0}", detail));
		case 429:
			return new Error(vscode.l10n.t("Rate limit exceeded (429). Please wait and try again.{0}", detail));
		default:
			return new Error(vscode.l10n.t("Kimi API error {0}: {1}{2}", error.statusCode, error.message, detail));
	}
}

function resolveThinkingEnabled(
	modelDef: KimiModelInfo,
	options: vscode.ProvideLanguageModelChatResponseOptions,
): boolean {
	if (!modelDef.thinking) {
		return false;
	}
	if (modelDef.thinkingType === "only") return true;

	return readStringOption(options, "thinkingMode") !== "disabled";
}

export class KimiChatProvider implements vscode.LanguageModelChatProvider {
	private apiKey: string | undefined;
	private readonly catalogs = new Map<string, ModelCatalog>();
	private bindings = new WeakMap<vscode.LanguageModelChatInformation, ModelCatalog>();
	private activeCatalog: ModelCatalog | undefined;
	private readonly accountChangedEmitter = new vscode.EventEmitter<Account | undefined>();
	readonly onDidChangeAccount = this.accountChangedEmitter.event;
	private readonly modelsChangedEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.modelsChangedEmitter.event;

	constructor(private readonly storage?: vscode.Memento, private readonly log: (message: string) => void = () => {}) {}

	get account(): Account | undefined {
		return this.apiKey ? { apiKey: this.apiKey, baseUrl: getApiBaseUrl() } : undefined;
	}

	get diagnosticConfiguration(): { account: Account; models: readonly KimiModelInfo[] } | undefined {
		const account = this.account;
		if (!account) return undefined;
		return { account, models: [...this.catalogFor(account.apiKey).models] };
	}

	private catalogFor(key: string): ModelCatalog {
		const baseUrl = getApiBaseUrl();
		const id = accountId(key, baseUrl);
		let catalog = this.catalogs.get(id);
		if (!catalog) {
			catalog = new ModelCatalog(key, baseUrl, this.storage, () => this.notifyModelsChanged(), this.log);
			this.catalogs.set(id, catalog);
		}
		return catalog;
	}

	private clearAccount(): void {
		this.apiKey = undefined;
		this.activeCatalog = undefined;
		this.bindings = new WeakMap();
		for (const catalog of this.catalogs.values()) catalog.dispose();
		this.catalogs.clear();
	}

	configurationChanged(): void {
		if (this.apiKey) {
			this.activeCatalog = this.catalogFor(this.apiKey);
			void this.activeCatalog.refresh();
		}
		this.accountChangedEmitter.fire(this.account);
		this.notifyModelsChanged();
	}

	async refreshModels(): Promise<void> {
		if (!this.activeCatalog) {
			vscode.window.showInformationMessage(vscode.l10n.t("Configure a Kimi API key in the model picker first."));
			return;
		}
		await this.activeCatalog.refresh();
		if (this.activeCatalog.error) {
			vscode.window.showWarningMessage(vscode.l10n.t("Kimi: Model refresh failed: {0}", this.activeCatalog.error));
		} else {
			vscode.window.showInformationMessage(vscode.l10n.t("Kimi: Found {0} compatible models.", this.activeCatalog.models.length));
		}
	}

	dispose(): void {
		this.clearAccount();
		this.modelsChangedEmitter.dispose();
		this.accountChangedEmitter.dispose();
	}

	notifyModelsChanged(): void {
		this.modelsChangedEmitter.fire();
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		const key = getApiKey(options);
		if (!key) {
			// No API key configured yet — return empty so VS Code doesn't
			// duplicate model entries during the base vendor scan.
			// Once the user sets an API key via the model picker, VS Code
			// will call this method again with the configuration present.
			// A vendor scan without configuration is not a credential deletion.
			if (hasProviderConfiguration(options)) {
				this.clearAccount();
				this.accountChangedEmitter.fire(undefined);
			}
			return [];
		}

		this.apiKey = key;
		const catalog = this.catalogFor(key);
		if (catalog !== this.activeCatalog) {
			this.activeCatalog = catalog;
			this.accountChangedEmitter.fire(this.account);
		}
		const models = await catalog.prepare();
		if (catalog.error && models.length === 0) {
			throw new Error(vscode.l10n.t("Kimi model list unavailable: {0}", catalog.error));
		}
		const source = catalog.source === "cache" ? vscode.l10n.t("cached")
			: catalog.source === "fallback" ? vscode.l10n.t("built-in fallback") : undefined;
		const suffix = [source, catalog.error].filter(Boolean).join(" · ");
		return models.map(model => {
			const original = toLanguageModelChatInformation(model);
			const info = { ...original, detail: original.detail + (suffix ? ` · ${suffix}` : "") };
			this.bindings.set(info, catalog);
			return info;
		});
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const key = getApiKey(options);
		const boundCatalog = this.bindings.get(model);
		const requestKey = key ?? boundCatalog?.apiKey ?? this.apiKey;
		const catalog = requestKey ? this.catalogFor(requestKey) : undefined;
		if (!catalog || !this.apiKey) {
			throw new Error(vscode.l10n.t("API key not configured. Configure it via the model picker."));
		}

		const client = new KimiApiClient(catalog.apiKey);
		const modelDef = catalog.models.find((m) => m.id === model.id);
		if (!modelDef) {
			throw new Error(vscode.l10n.t("Unknown Kimi model: {0}", model.id));
		}

		const budget = getModelTokenBudget(modelDef);
		const thinking = resolveThinkingEnabled(modelDef, options);
		const requestOptions = options as KimiResponseOptions;
		const selectedEffort =
			requestOptions.modelOptions?.reasoningEffort ??
			requestOptions.modelConfiguration?.reasoningEffort ??
			requestOptions.configuration?.reasoningEffort;
		const reasoningEffort = thinking && modelDef.supportsReasoningEffort
			? getReasoningEffort(selectedEffort)
			: undefined;
		if (reasoningEffort && !modelDef.reasoningEfforts?.includes(reasoningEffort)) {
			throw new Error(vscode.l10n.t(
				"Reasoning effort '{0}' is not supported by {1}. Select a supported level.", reasoningEffort, model.id,
			));
		}
		const kimiMessages = convertMessages(messages, thinking);
		const kimiTools = convertTools(options.tools);

		const requestedMaxTokens = options.modelOptions?.maxTokens;
		if (
			requestedMaxTokens !== undefined &&
			(
				typeof requestedMaxTokens !== "number" ||
				!Number.isInteger(requestedMaxTokens) ||
				requestedMaxTokens <= 0
			)
		) {
			throw new Error(vscode.l10n.t("maxTokens must be a positive integer."));
		}
		const maxTokens = typeof requestedMaxTokens === "number"
			? Math.min(requestedMaxTokens, budget.maxOutputTokens)
			: budget.maxOutputTokens;

		try {
			const stream = client.streamChat(
				model.id,
				kimiMessages,
				catalog.baseUrl,
				{
					maxTokens,
					tools: kimiTools,
					thinking,
					reasoningEffort,
					promptCacheKey: getPromptCacheKey(options),
					toolMode: options.toolMode,
					requireSseDoneMarker: modelDef.requireSseDoneMarker,
					onRetry: (status, delayMs, attempt) => this.log(
						`Chat request returned HTTP ${status}; retry ${attempt} in ${delayMs} ms.`,
					),
				},
				token,
			);

			const toolCalls = new ToolCallAccumulator();
			let usage: TokenUsage | undefined;

			for await (const chunk of stream) {
				if (token.isCancellationRequested) break;
				// Usage is a cumulative snapshot, often in a final chunk with no choices.
				usage = parseTokenUsage(chunk.usage) ?? usage;

				for (const choice of chunk.choices ?? []) {
					const delta = choice.delta;

					if (delta.reasoning_content) {
						const thinkingPart = createThinkingPart(delta.reasoning_content);
						if (thinkingPart) progress.report(thinkingPart);
					}

					if (delta.content) {
						progress.report(new vscode.LanguageModelTextPart(delta.content));
					}

					for (const toolCall of delta.tool_calls ?? []) {
						toolCalls.add(toolCall);
					}

					if (choice.finish_reason === "tool_calls") {
						toolCalls.emit(progress);
					}
				}
			}

			toolCalls.emit(progress);
			if (!token.isCancellationRequested) {
				if (usage) {
					// Copilot's extChatEndpoint consumes JSON DataParts with the internal
					// MIME type "usage". This is not yet a public token-usage API.
					progress.report(new vscode.LanguageModelDataPart(
						new TextEncoder().encode(JSON.stringify(usage)), "usage",
					));
					this.log(`Token usage: input=${usage.prompt_tokens}, output=${usage.completion_tokens}, total=${usage.total_tokens}`);
				} else {
					this.log("Token usage unavailable: the response did not include valid usage counts.");
				}
			}
		} catch (error) {
			if (!(error instanceof KimiApiError)) throw error;
			throw mapKimiApiError(error);
		}
	}

	provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Thenable<number> {
		return Promise.resolve(estimateTokenCount(text));
	}
}
