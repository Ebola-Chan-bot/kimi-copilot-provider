import * as vscode from "vscode";

interface ToolCallBuilder {
	id: string;
	name: string;
	arguments: string;
}

export interface ToolCallDelta {
	index: number;
	id?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
	const s = raw.trim() || "{}";
	try {
		const parsed: unknown = JSON.parse(s);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return { _nonObjectToolArguments: parsed };
	} catch {
		return {
			_invalidToolArgumentsJson: true,
			_rawArguments: raw,
		};
	}
}

/** Accumulates streamed tool call fragments, keyed by their index, until they are complete. */
export class ToolCallAccumulator {
	private readonly builders = new Map<number, ToolCallBuilder>();

	add(delta: ToolCallDelta): void {
		let builder = this.builders.get(delta.index);
		if (!builder) {
			builder = { id: "", name: "", arguments: "" };
			this.builders.set(delta.index, builder);
		}

		if (delta.id) builder.id = delta.id;
		if (delta.function?.name) builder.name = delta.function.name;
		if (delta.function?.arguments) builder.arguments += delta.function.arguments;
	}

	emit(progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
		for (const builder of this.builders.values()) {
			if (!builder.id || !builder.name) continue;

			const args = parseToolCallArguments(builder.arguments);
			progress.report(
				new vscode.LanguageModelToolCallPart(builder.id, builder.name, args),
			);
		}
		this.builders.clear();
	}
}
