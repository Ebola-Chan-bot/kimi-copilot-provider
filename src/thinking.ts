import * as vscode from "vscode";

// LanguageModelThinkingPart is a proposed API; it may be absent at runtime.
type ThinkingPartConstructor = new (value: string) => vscode.LanguageModelResponsePart;

function thinkingPartConstructor(): ThinkingPartConstructor | undefined {
	const ctor = (vscode as typeof vscode & { LanguageModelThinkingPart?: ThinkingPartConstructor })
		.LanguageModelThinkingPart;
	return typeof ctor === "function" ? ctor : undefined;
}

export function createThinkingPart(text: string): vscode.LanguageModelResponsePart | undefined {
	const ThinkingPart = thinkingPartConstructor();
	return ThinkingPart ? new ThinkingPart(text) : undefined;
}

export function isThinkingPart(part: unknown): part is vscode.LanguageModelResponsePart {
	const ThinkingPart = thinkingPartConstructor();
	return ThinkingPart !== undefined && part instanceof ThinkingPart;
}

export function getValueFromThinkingPart(part: unknown): string | undefined {
	const candidate = part as { value?: unknown } | null;
	if (!candidate || !candidate.value) {
		return undefined;
	}

	if (typeof candidate.value === "string") {
		return candidate.value;
	}

	if (Array.isArray(candidate.value)) {
		return candidate.value.join("");
	}

	return undefined;
}
