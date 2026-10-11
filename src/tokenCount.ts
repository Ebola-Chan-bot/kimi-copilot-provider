import * as vscode from "vscode";
import { toolResultContent } from "./messages.js";
import { getValueFromThinkingPart, isThinkingPart } from "./thinking.js";

/**
 * Tokens per character outside CJK scripts: the usual ~4 characters per token
 * for English prose and source code.
 */
const LATIN_TOKENS_PER_CHAR = 1 / 4;
/**
 * CJK characters take 0.6–1 token each; count the upper bound so Chinese-heavy
 * chats are truncated a little early instead of rejected for exceeding the window.
 */
const CJK_TOKENS_PER_CHAR = 1;
// Han, kana, Hangul and CJK/fullwidth punctuation.
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]|[\ud840-\ud87f][\udc00-\udfff]/g;

/** Estimated tokens in a piece of text, unrounded so callers can sum parts first. */
function textTokens(text: string): number {
	if (!text) return 0;
	const cjk = text.match(CJK);
	const cjkChars = cjk?.length ?? 0;
	const cjkCodeUnits = cjk?.reduce((sum, char) => sum + char.length, 0) ?? 0;
	return cjkChars * CJK_TOKENS_PER_CHAR + (text.length - cjkCodeUnits) * LATIN_TOKENS_PER_CHAR;
}

/**
 * Rough token estimate for what convertMessages sends for this message,
 * including tool calls and tool results, which dominate Agent-mode context.
 */
export function estimateTokenCount(text: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof text === "string") {
		return Math.ceil(textTokens(text));
	}

	let tokens = 0;
	for (const part of text.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			tokens += textTokens(part.value);
		} else if (part instanceof vscode.LanguageModelDataPart) {
			tokens += part.mimeType.toLowerCase().startsWith("image/")
				? part.data.length * LATIN_TOKENS_PER_CHAR
				: textTokens(toolResultContent([part]));
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			tokens += textTokens(part.callId) + textTokens(part.name) + textTokens(JSON.stringify(part.input) ?? "");
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			tokens += textTokens(part.callId) + textTokens(toolResultContent(part.content));
		} else if (isThinkingPart(part)) {
			tokens += textTokens(getValueFromThinkingPart(part) ?? "");
		}
	}
	return Math.ceil(tokens);
}

/**
 * Mirrors how Copilot Chat budgets a request for an extension-contributed model
 * (ExtensionContributedChatTokenizer): per-message and per-tool overheads around
 * provideTokenCount. Comparing this with the server's prompt_tokens shows how far
 * the context figure VS Code works with is from what the server counts.
 */
export function estimateRequestTokens(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	tools: readonly vscode.LanguageModelChatTool[] = [],
): { messages: number; tools: number; total: number } {
	const messageTokens = messages.reduce((sum, message) => sum + 3 + estimateTokenCount(message), 3);
	const objectTokens = (value: Record<string, unknown>): number => Object.entries(value).reduce((sum, [key, item]) => {
		if (!item) return sum;
		if (typeof item === "string") return sum + estimateTokenCount(key) + estimateTokenCount(item);
		if (typeof item === "object") return sum + estimateTokenCount(key) + objectTokens(item as Record<string, unknown>);
		return sum + estimateTokenCount(key);
	}, 0);
	const toolTokens = tools.length === 0 ? 0 : Math.floor(1.1 * tools.reduce(
		(sum, tool) => sum + 8 + objectTokens({ name: tool.name, description: tool.description, parameters: tool.inputSchema }),
		16,
	));
	return { messages: messageTokens, tools: toolTokens, total: messageTokens + toolTokens };
}
