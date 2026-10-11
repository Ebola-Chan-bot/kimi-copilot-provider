import * as vscode from "vscode";
import { runConfigurationDiagnostics } from "./diagnostics";
import {
	API_BASE_URL_KEY,
	CONFIG_SECTION,
	PRESET_URLS,
	setApiBaseUrl,
	setPresetEndpoint,
} from "./config";
import { KimiChatProvider } from "./provider";
import { UsageStatusBar } from "./usage";

/** Endpoints selectable for completeness, without model catalog, quota or credential support. */
const UNSUPPORTED_ENDPOINTS: ReadonlySet<keyof typeof PRESET_URLS> = new Set(["moonshot", "moonshotCN"]);

async function setBaseUrlAndNotify(
	provider: KimiChatProvider,
	endpoint: keyof typeof PRESET_URLS,
	label: string,
): Promise<void> {
	if (UNSUPPORTED_ENDPOINTS.has(endpoint)) {
		const switchAnyway = vscode.l10n.t("Switch Anyway");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t("{0} is not yet supported. Model discovery, usage and Kimi Code subscription keys may not work with it.", label),
			{ modal: true },
			switchAnyway,
		);
		if (choice !== switchAnyway) return;
	}
	await setPresetEndpoint(endpoint);
	provider.notifyModelsChanged();
	vscode.window.showInformationMessage(vscode.l10n.t("Kimi: Switched to {0} ({1})", label, PRESET_URLS[endpoint]));
}

async function setCustomBaseUrl(provider: KimiChatProvider): Promise<void> {
	const input = await vscode.window.showInputBox({
		prompt: vscode.l10n.t("Enter custom Kimi API base URL"),
		placeHolder: PRESET_URLS.kimiCode,
		value: vscode.workspace
			.getConfiguration(CONFIG_SECTION)
			.get<string>(API_BASE_URL_KEY, ""),
		validateInput: (value) => {
			if (!value || value.trim().length === 0) {
				return vscode.l10n.t("URL cannot be empty");
			}
			try {
				new URL(value.trim());
				return undefined;
			} catch {
				return vscode.l10n.t("Invalid URL");
			}
		},
	});
	if (!input) return;
	await setApiBaseUrl(input.trim());
	provider.notifyModelsChanged();

	vscode.window.showInformationMessage(
		vscode.l10n.t("Kimi: Switched to custom endpoint ({0})", input.trim()),
	);
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Kimi");
	const log = (message: string) => output.appendLine(`[${new Date().toISOString()}] ${message}`);
	const provider = new KimiChatProvider(context.globalState, log);
	let diagnosticRun: Promise<void> | undefined;
	const diagnose = () => diagnosticRun ??= runConfigurationDiagnostics(provider, output).finally(() => { diagnosticRun = undefined; });
	const usage = new UsageStatusBar(log);
	const updateUsage = () => usage.configure(provider.account,
		vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("showUsageStatusBar", true));

	context.subscriptions.push(
		output, provider, usage,
		provider.onDidChangeAccount(updateUsage),
		vscode.lm.registerLanguageModelChatProvider("kimi", provider),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("kimi.endpoint") || event.affectsConfiguration("kimi.apiBaseUrl")) {
				provider.configurationChanged();
			} else if (event.affectsConfiguration("kimi")) {
				provider.notifyModelsChanged();
			}
			if (event.affectsConfiguration("kimi")) updateUsage();
		}),
		vscode.commands.registerCommand("kimi.refreshModels", () => provider.refreshModels()),
		vscode.commands.registerCommand("kimi.refreshUsage", () => usage.refresh()),
		vscode.commands.registerCommand("kimi.usageActions", async () => {
			const action = await vscode.window.showQuickPick([
				{ label: `$(refresh) ${vscode.l10n.t("Refresh Usage")}`, action: "refresh" },
				{ label: `$(link-external) ${vscode.l10n.t("Open Kimi Console")}`, action: "console" },
			], { title: vscode.l10n.t("Kimi Code Usage") });
			if (action?.action === "refresh") await usage.refresh();
			if (action?.action === "console") {
				await vscode.env.openExternal(vscode.Uri.parse("https://www.kimi.com/code/console"));
			}
		}),
		vscode.commands.registerCommand("kimi.diagnoseConfiguration", diagnose),
		// Deprecated alias kept for existing keybindings; hidden from the Command Palette.
		vscode.commands.registerCommand("kimi.testConnection", () => {
			log("kimi.testConnection is deprecated; use kimi.diagnoseConfiguration instead.");
			return diagnose();
		}),
		vscode.commands.registerCommand("kimi.setBaseUrl.kimiCode", () =>
			setBaseUrlAndNotify(provider, "kimiCode", vscode.l10n.t("Global API (kimi.ai)")),
		),
		vscode.commands.registerCommand("kimi.setBaseUrl.kimiCodeCN", () =>
			setBaseUrlAndNotify(provider, "kimiCodeCN", vscode.l10n.t("China API (kimi.com)")),
		),
		vscode.commands.registerCommand("kimi.setBaseUrl.moonshot", () =>
			setBaseUrlAndNotify(provider, "moonshot", vscode.l10n.t("Moonshot API (moonshot.ai)")),
		),
		vscode.commands.registerCommand("kimi.setBaseUrl.moonshotCN", () =>
			setBaseUrlAndNotify(provider, "moonshotCN", vscode.l10n.t("Moonshot China API (moonshot.cn)")),
		),
		vscode.commands.registerCommand("kimi.setBaseUrl.custom", () =>
			setCustomBaseUrl(provider),
		),
	);
}

export function deactivate(): void { }
