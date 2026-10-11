import * as vscode from "vscode";
import { KimiApiClient, KimiApiError } from "./api";
import { getReasoningEffort } from "./config";
import { getModelTokenBudget, parseModels, type KimiModelInfo } from "./models";
import type { KimiChatProvider } from "./provider";
import type { Account } from "./usage";

export interface DiagnosticCheck {
	name: string;
	status: "PASS" | "WARN" | "FAIL" | "CANCELLED";
	detail: string;
}

export interface DiagnosticDiscovery {
	models: readonly KimiModelInfo[];
	check: DiagnosticCheck;
}

function errorDetail(error: unknown): string {
	// Never include arbitrary server bodies/errors: a proxy can echo credentials or prompts.
	if (error instanceof KimiApiError) {
		const hints: Record<number, string> = {
			401: vscode.l10n.t("Check the API key and subscription access to this model/context."),
			402: vscode.l10n.t("Check membership benefits in the Kimi console."),
			403: vscode.l10n.t("Check account quota and concurrent request limits in the Kimi console."),
			404: vscode.l10n.t("Check the endpoint URL and whether it supports this API."),
			429: vscode.l10n.t("The server is rate limited or overloaded; wait before trying again."),
		};
		const hint = hints[error.statusCode] ?? vscode.l10n.t("Check endpoint connectivity and the service status.");
		return `HTTP ${error.statusCode}. ${hint}`;
	}
	if (error instanceof Error && error.name === "AbortError") {
		return vscode.l10n.t("Request timed out or was cancelled. Check the connection and retry.");
	}
	return vscode.l10n.t("Network error or invalid response. Check the endpoint, proxy and connection.");
}

export async function discoverDiagnosticModels(
	account: Account,
	fallback: readonly KimiModelInfo[],
	signal: AbortSignal,
): Promise<DiagnosticDiscovery> {
	const name = vscode.l10n.t("Model discovery");
	try {
		const payload = await new KimiApiClient(account.apiKey).getMetadata(account.baseUrl, "/models", signal);
		const models = parseModels(payload, account.baseUrl);
		return { models, check: {
			name, status: models.length ? "PASS" : "FAIL",
			detail: models.length
				? vscode.l10n.t("{0} compatible models returned by the server.", models.length)
				: vscode.l10n.t("The server returned no compatible chat models. Check account access and endpoint."),
		} };
	} catch (error) {
		const fallbackNote = fallback.length
			? ` ${vscode.l10n.t("Cached/fallback models are available for response checks; discovery did not pass.")}`
			: "";
		return { models: signal.aborted ? [] : fallback, check: {
			name, status: signal.aborted ? "CANCELLED" : "FAIL",
			detail: signal.aborted ? vscode.l10n.t("Cancelled.") : `${errorDetail(error)}${fallbackNote}`,
		} };
	}
}

export async function diagnoseResponses(
	account: Account,
	model: KimiModelInfo,
	signal: AbortSignal,
	onStep: (name: string) => void = () => {},
	timeoutMs = 60_000,
): Promise<DiagnosticCheck[]> {
	const checks: DiagnosticCheck[] = [];
	const settingsCheck = vscode.l10n.t("Request settings");
	const thinking = model.thinking;
	let reasoningEffort;
	try {
		reasoningEffort = thinking && model.supportsReasoningEffort ? getReasoningEffort() : undefined;
		if (reasoningEffort && !model.reasoningEfforts?.includes(reasoningEffort)) {
			checks.push({
				name: settingsCheck, status: "FAIL",
				detail: vscode.l10n.t("The global reasoning effort is unsupported by this model. Select a supported value or Default in Kimi settings."),
			});
			return checks;
		}
	} catch {
		return [{
			name: settingsCheck, status: "FAIL",
			detail: vscode.l10n.t("Invalid global reasoning effort. Check Kimi settings."),
		}];
	}
	const options = {
		thinking, reasoningEffort,
		maxTokens: Math.min(1024, getModelTokenBudget(model).maxOutputTokens),
		requireSseDoneMarker: model.requireSseDoneMarker,
		// Report the endpoint's real behavior instead of masking 429/5xx with retries.
		maxRetries: 0,
	};
	checks.push({
		name: settingsCheck, status: "PASS",
		detail: vscode.l10n.t(
			"Thinking {0}; effort {1}; diagnostic output limit {2}.",
			thinking ? vscode.l10n.t("enabled") : vscode.l10n.t("disabled"),
			reasoningEffort ?? vscode.l10n.t("server default"),
			options.maxTokens,
		),
	});
	const client = new KimiApiClient(account.apiKey);
	const messages = [{ role: "user" as const, content: "Reply with OK only." }];
	for (const streaming of [false, true]) {
		const name = streaming ? vscode.l10n.t("Streaming response") : vscode.l10n.t("Non-streaming response");
		if (signal.aborted) {
			checks.push({ name, status: "CANCELLED", detail: vscode.l10n.t("Cancelled; no further request sent.") });
			break;
		}
		onStep(name);
		const controller = new AbortController();
		const requestSignal = AbortSignal.any([signal, controller.signal]);
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const started = Date.now();
		try {
			let receivedContent = false;
			let finishReason: string | undefined;
			if (!streaming) {
				const response = await client.chat(model.id, messages, account.baseUrl, options, undefined, requestSignal);
				const choice = response?.choices?.[0];
				const message = choice?.message as { content?: unknown; reasoning_content?: unknown } | undefined;
				receivedContent = [message?.content, message?.reasoning_content].some(value => typeof value === "string" && value.trim().length > 0);
				finishReason = choice?.finish_reason;
			} else {
				for await (const chunk of client.streamChat(model.id, messages, account.baseUrl, options, undefined, requestSignal)) {
					for (const choice of chunk.choices ?? []) {
						if (choice.index !== 0) continue;
						receivedContent ||= [choice.delta?.content, choice.delta?.reasoning_content].some(value => typeof value === "string" && value.trim().length > 0);
						if (choice.finish_reason) finishReason = choice.finish_reason;
					}
				}
			}
			if (requestSignal.aborted) throw new Error("Aborted");
			const elapsed = `${Date.now() - started} ms`;
			if (!receivedContent || !["stop", "length"].includes(finishReason ?? "")) {
				checks.push({
					name, status: "FAIL",
					detail: vscode.l10n.t("No valid completed text/thinking response ({0}). Check endpoint response format; HTTP success alone does not pass.", elapsed),
				});
			} else if (finishReason === "length") {
				checks.push({
					name, status: "WARN",
					detail: vscode.l10n.t("Response received ({0}), but reached the diagnostic output limit; the answer may be incomplete.", elapsed),
				});
			} else {
				checks.push({ name, status: "PASS", detail: vscode.l10n.t("Completed text/thinking response received ({0}).", elapsed) });
			}
		} catch (error) {
			const detail = signal.aborted ? vscode.l10n.t("Cancelled.")
				: controller.signal.aborted ? vscode.l10n.t("Timed out. Check connection or retry with a faster model/lower supported reasoning effort.")
					: errorDetail(error);
			checks.push({ name, status: signal.aborted ? "CANCELLED" : "FAIL", detail });
		} finally {
			clearTimeout(timer);
		}
	}
	return checks;
}

export function formatDiagnosticReport(account: Account, model: KimiModelInfo | undefined, checks: readonly DiagnosticCheck[]): string {
	const redact = (value: string) => value.split(account.apiKey).join("[REDACTED]").split(encodeURIComponent(account.apiKey)).join("[REDACTED]");
	let endpoint = vscode.l10n.t("Invalid endpoint URL");
	try {
		const url = new URL(account.baseUrl);
		endpoint = url.origin + url.pathname; // Exclude URL credentials, query and fragment.
	} catch { /* Do not print unvalidated input. */ }
	return redact([
		vscode.l10n.t("Kimi configuration diagnostics"),
		vscode.l10n.t("Time: {0}", new Date().toISOString()),
		vscode.l10n.t("Extension: {0}; VS Code: {1}", require("../package.json").version, vscode.version),
		vscode.l10n.t("Endpoint: {0}", endpoint),
		vscode.l10n.t("Model: {0}", model?.id ?? vscode.l10n.t("Not selected")),
		vscode.l10n.t("Scope: loaded provider account and global Kimi settings; current chat overrides are not inspected."),
		...checks.map(check => `[${check.status}] ${check.name}: ${check.detail}`),
		vscode.l10n.t("This check does not verify images, tools, multi-turn history or maximum context entitlement."),
		vscode.l10n.t("API keys, URL credentials/query/fragment, response bodies, prompts and model output are omitted."),
	].join("\n"));
}

function summaryMessage(checks: readonly DiagnosticCheck[]): string {
	if (checks.some(check => check.status === "CANCELLED")) return vscode.l10n.t("Kimi diagnostics cancelled.");
	if (checks.some(check => check.status === "FAIL")) {
		return vscode.l10n.t("Kimi diagnostics found a problem. See the Kimi output channel.");
	}
	if (checks.some(check => check.status === "WARN")) {
		return vscode.l10n.t("Kimi diagnostics completed with a warning. See the Kimi output channel.");
	}
	return vscode.l10n.t("Kimi diagnostics passed.");
}

export async function runConfigurationDiagnostics(provider: KimiChatProvider, output: vscode.OutputChannel): Promise<void> {
	try {
		// Ask VS Code to enumerate configured Kimi accounts after a fresh window reload.
		if (!provider.diagnosticConfiguration) await vscode.lm.selectChatModels({ vendor: "kimi" });
		const configuration = provider.diagnosticConfiguration;
		if (!configuration) {
			await vscode.window.showInformationMessage(vscode.l10n.t("Kimi: No provider key is loaded. Open Chat → Manage Language Models, add/configure Kimi, then run diagnostics again. No API key is requested or saved by this command."));
			return;
		}
		const report = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t("Kimi: Diagnose Current Configuration"),
			cancellable: true,
		}, async (progress, token) => {
			const controller = new AbortController();
			const listener = token.onCancellationRequested(() => controller.abort());
			if (token.isCancellationRequested) controller.abort();
			try {
				progress.report({ message: vscode.l10n.t("Checking model discovery…") });
				const discovery = await discoverDiagnosticModels(configuration.account, configuration.models, controller.signal);
				const checks = [discovery.check];
				let model: KimiModelInfo | undefined;
				if (discovery.models.length && !token.isCancellationRequested) {
					const selection = await vscode.window.showQuickPick(discovery.models.map(model => ({
						label: model.name, description: model.id, model,
					})), {
						title: vscode.l10n.t("Kimi: Select a model to diagnose"),
						placeHolder: vscode.l10n.t("Sends two small test requests using the loaded key and global settings; uses account quota."),
					}, token);
					if (!selection) return undefined;
					model = selection.model;
					checks.push(...await diagnoseResponses(configuration.account, model, controller.signal, name => progress.report({ message: `${name}…` })));
				}
				return { text: formatDiagnosticReport(configuration.account, model, checks), checks };
			} finally { listener.dispose(); }
		});
		if (!report) return;
		output.appendLine(report.text);
		output.show(true);
		const copyAction = vscode.l10n.t("Copy Sanitized Report");
		const action = await vscode.window.showInformationMessage(summaryMessage(report.checks), copyAction);
		if (action === copyAction) await vscode.env.clipboard.writeText(report.text);
	} catch {
		await vscode.window.showErrorMessage(vscode.l10n.t("Kimi diagnostics could not start. Check the endpoint settings and reopen Chat → Manage Language Models."));
	}
}
