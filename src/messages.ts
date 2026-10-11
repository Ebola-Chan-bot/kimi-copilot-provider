import * as vscode from "vscode";
import type { KimiMessage, KimiTool } from "./api.js";
import { assistantToolCallThinkingPayload } from "./reasoning.js";
import { getValueFromThinkingPart, isThinkingPart } from "./thinking.js";

type ImagePart = { type: "image_url"; image_url: { url: string } };

// Copilot marks prompt-cache breakpoints with this data part; it carries no content.
const CACHE_CONTROL_MIME = "cache_control";

function isTextMime(mime: string): boolean {
	return mime === "text/plain" || mime === "application/json" || mime.endsWith("+json");
}

/** Text for a non-image data part, or a placeholder describing what was omitted. */
function dataPartText(part: vscode.LanguageModelDataPart, omitted: string): string {
	const mime = part.mimeType.toLowerCase();
	if (mime === CACHE_CONTROL_MIME) return "";
	if (isTextMime(mime)) return new TextDecoder("utf-8", { fatal: false }).decode(part.data);
	return `\n[${omitted}: ${part.mimeType}, ${part.data.length} bytes]\n`;
}

/**
 * Flattens tool result parts into the plain string the tool role expects.
 * Text parts contribute their value, not a JSON envelope around it.
 */
export function toolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
	return content.map(part => {
		if (part instanceof vscode.LanguageModelTextPart) return part.value;
		if (part instanceof vscode.LanguageModelDataPart) {
			return dataPartText(part, "Tool result attachment omitted");
		}
		if (typeof part === "string") return part;
		return JSON.stringify(part) ?? "";
	}).join("");
}

function convertRole(
	role: vscode.LanguageModelChatMessageRole,
): "system" | "user" | "assistant" {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return "user";
		case vscode.LanguageModelChatMessageRole.Assistant:
			return "assistant";
		default:
			return "user";
	}
}

export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	thinkingEnabled: boolean,
): KimiMessage[] {
	const result: KimiMessage[] = [];

	for (const msg of messages) {
		const role = convertRole(msg.role);
		const textParts: string[] = [];
		const imageParts: ImagePart[] = [];
		let toolCalls: KimiMessage["tool_calls"] | undefined;
		const toolResults: Array<{ callId: string; content: string }> = [];
		let reasoningFromThinkingPart: string | undefined;

		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType.toLowerCase().startsWith("image/")) {
					const b64 = Buffer.from(part.data).toString("base64");
					imageParts.push({
						type: "image_url",
						image_url: { url: `data:${part.mimeType};base64,${b64}` },
					});
				} else {
					const text = dataPartText(part, "Attachment omitted (not an image)");
					if (text) textParts.push(text);
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				if (!toolCalls) toolCalls = [];
				toolCalls.push({
					id: part.callId,
					type: "function",
					function: {
						name: part.name,
						arguments: JSON.stringify(part.input),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({
					callId: part.callId,
					content: toolResultContent(part.content),
				});
			} else if (isThinkingPart(part)) {
				const thinkingValue = getValueFromThinkingPart(part);
				if (thinkingValue) {
					reasoningFromThinkingPart = reasoningFromThinkingPart
						? reasoningFromThinkingPart + thinkingValue
						: thinkingValue;
				}
			}
		}

		for (const toolResult of toolResults) {
			result.push({ role: "tool", content: toolResult.content, tool_call_id: toolResult.callId });
		}

		if (toolCalls && toolCalls.length > 0) {
			const mergedText = textParts.join("") || "";
			if (thinkingEnabled && reasoningFromThinkingPart) {
				result.push({
					role: "assistant",
					content: mergedText,
					tool_calls: toolCalls,
					reasoning_content: reasoningFromThinkingPart,
				});
			} else if (thinkingEnabled) {
				const { content, reasoning_content } =
					assistantToolCallThinkingPayload(mergedText);
				result.push({
					role: "assistant",
					content,
					tool_calls: toolCalls,
					reasoning_content,
				});
			} else {
				result.push({
					role: "assistant",
					content: mergedText,
					tool_calls: toolCalls,
				});
			}
		} else if (toolResults.length === 0) {
			const content: KimiMessage["content"] =
				imageParts.length > 0
					? [
						...textParts.map((t) => ({ type: "text" as const, text: t })),
						...imageParts,
					]
					: textParts.join("");
			result.push({ role, content, name: msg.name });
		}
	}

	return result;
}

export function convertTools(
	tools?: readonly vscode.LanguageModelChatTool[],
): KimiTool[] | undefined {
	if (!tools || tools.length === 0) return undefined;

	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: (tool.inputSchema ?? {}) as Record<string, unknown>,
		},
	}));
}
