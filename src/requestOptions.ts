import type * as vscode from "vscode";

// Compatibility fields used by the current VS Code model picker (non-public API).
// VS Code 1.120+ passes provider config as modelConfiguration; <=1.119 as configuration.
export type KimiResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Readonly<Record<string, unknown>>;
	readonly configuration?: Readonly<Record<string, unknown>>;
};

export function getObjectProperty(source: unknown, key: string): unknown {
	if (!source || typeof source !== "object") {
		return undefined;
	}

	return (source as Record<string, unknown>)[key];
}

function getStringProperty(source: unknown, key: string): string | undefined {
	const value = getObjectProperty(source, key);
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

/** Whether the options carry a provider configuration at all (even an empty one). */
export function hasProviderConfiguration(options: unknown): boolean {
	return getObjectProperty(options, "modelConfiguration") !== undefined
		|| getObjectProperty(options, "configuration") !== undefined;
}

export function getApiKey(options: unknown): string | undefined {
	return getStringProperty(getObjectProperty(options, "modelConfiguration"), "apiKey")
		?? getStringProperty(getObjectProperty(options, "configuration"), "apiKey");
}

export function getPromptCacheKey(options: unknown): string | undefined {
	return getStringProperty(getObjectProperty(options, "metadata"), "taskId");
}

/** Reads a string option from modelOptions, then modelConfiguration, then legacy configuration. */
export function readStringOption(options: unknown, key: string): string | undefined {
	return getStringProperty(getObjectProperty(options, "modelOptions"), key)
		?? getStringProperty(getObjectProperty(options, "modelConfiguration"), key)
		?? getStringProperty(getObjectProperty(options, "configuration"), key);
}
