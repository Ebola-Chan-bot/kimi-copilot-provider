import * as vscode from "vscode";
import { getValueFromThinkingPart, isThinkingPart } from "./thinking.js";

/** Rough token estimate (about four characters per token). */
export function estimateTokenCount(text: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof text === "string") {
		return Math.ceil(text.length / 4);
	}

	let totalChars = 0;
	for (const part of text.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			totalChars += part.value.length;
		} else if (part instanceof vscode.LanguageModelDataPart) {
			totalChars += part.data.length;
		} else if (isThinkingPart(part)) {
			const thinkingValue = getValueFromThinkingPart(part);
			if (thinkingValue) {
				totalChars += thinkingValue.length;
			}
		}
	}
	return Math.ceil(totalChars / 4);
}
