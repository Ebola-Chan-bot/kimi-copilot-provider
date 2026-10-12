import * as vscode from "vscode";
import { hostname, type, release, machine, version } from "node:os";
import { randomUUID } from "node:crypto";
import { getSendDeviceInfoEnabled, type ReasoningEffort } from "./config.js";

const CHAT_ENDPOINT = "/chat/completions";
/** Statuses worth retrying: rate limiting and transient server/gateway failures. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;
/** A server asking for a longer wait than this fails fast instead of stalling the chat. */
const MAX_RETRY_DELAY_MS = 30_000;
const EXTENSION_MANIFEST = require("../package.json") as {
	name: string;
	publisher: string;
	version: string;
};
const EXTENSION_ID = `${EXTENSION_MANIFEST.publisher}.${EXTENSION_MANIFEST.name}`;
let deviceId: string | undefined;

function asciiHeaderValue(value: string, fallback = "unknown"): string {
	const sanitized = value.replace(/[^\x20-\x7e]/g, "").trim();
	return sanitized || fallback;
}

function kimiDeviceModel(): string {
	const system = type();
	const rel = release();
	const mach = machine?.() ?? "";

	if (system === "Darwin") {
		return `macOS ${rel} ${mach}`.trim();
	}

	if (system === "Windows_NT") {
		const parts = rel.split(".");
		const build = Number(parts[2] ?? "");
		const label =
			parts[0] === "10"
				? Number.isFinite(build) && build >= 22000
					? "11"
					: "10"
				: rel;
		return `Windows ${label} ${mach}`.trim();
	}

	if (system) {
		return `${system} ${rel} ${mach}`.trim();
	}

	return "Unknown";
}

function getDefaultHeaders(apiKey: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		"User-Agent": asciiHeaderValue(
			`kimi-lm-provider/${EXTENSION_MANIFEST.version} (VSCode/${vscode.version}; ${EXTENSION_ID})`,
		),
		"X-Msh-Platform": "kimi-lm-provider",
		"X-Msh-Version": EXTENSION_MANIFEST.version,
	};
	if (getSendDeviceInfoEnabled()) {
		deviceId ??= randomUUID().replace(/-/g, "");
		headers["X-Msh-Device-Name"] = asciiHeaderValue(hostname() || "unknown");
		headers["X-Msh-Device-Model"] = asciiHeaderValue(kimiDeviceModel());
		headers["X-Msh-Device-Id"] = deviceId;
		headers["X-Msh-Os-Version"] = asciiHeaderValue(
			version?.() || `${type()} ${release()}`,
		);
	}
	return headers;
}

export type KimiContent =
	| string
	| Array<
		| { type: "text"; text: string }
		| { type: "image_url"; image_url: { url: string } }
	>;

export interface KimiMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: KimiContent;
	name?: string;
	tool_calls?: KimiToolCall[];
	tool_call_id?: string;
	reasoning_content?: string;
}

export interface KimiToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface KimiTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface ChatOptions {
	topP?: number;
	maxTokens?: number;
	tools?: KimiTool[];
	stop?: string[];
	thinking?: boolean;
	/** Send the K2.x `thinking` object. False for models controlled only by `reasoning_effort` (Kimi K3). */
	thinkingParameter?: boolean;
	reasoningEffort?: ReasoningEffort;
	promptCacheKey?: string;
	toolMode?: vscode.LanguageModelChatToolMode;
	/** False when the model rejects `tool_choice: "required"`; Required mode then falls back to `auto`. */
	requiredToolChoice?: boolean;
	/**
	 * When true (default), the stream must end with `data: [DONE]` or an error is thrown (Moonshot streaming docs).
	 * Kimi Coding (`api.kimi.com/coding`) may close the connection without sending `[DONE]`; set false for that endpoint.
	 */
	requireSseDoneMarker?: boolean;
	/** Retries for 429/5xx responses before any data is received. Defaults to 3. */
	maxRetries?: number;
	onRetry?: (status: number, delayMs: number, attempt: number) => void;
}

interface KimiStreamChunk {
	usage?: unknown;
	id: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		/** Some Moonshot examples nest the final usage here instead of at the top level. */
		usage?: unknown;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason: string | null;
	}>;
}

interface KimiResponse {
	id: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: {
			role: string;
			content: string;
			tool_calls?: KimiToolCall[];
		};
		finish_reason: string;
	}>;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export class KimiApiError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly response?: unknown,
	) {
		super(message);
		this.name = "KimiApiError";
	}
}

export function summarizeErrorResponse(response: unknown, maxChars = 400): string {
	try {
		const text =
			typeof response === "string" ? response : JSON.stringify(response);
		if (text.length <= maxChars) {
			return text;
		}
		return `${text.slice(0, maxChars)}...`;
	} catch {
		return "";
	}
}

export class KimiApiClient {
	private readonly headers: Record<string, string>;

	constructor(apiKey: string) {
		this.headers = getDefaultHeaders(apiKey);
	}

	/** Metadata requests have their own timeout/cancellation, independent of chat. */
	async getMetadata(baseUrl: string, path: "/models" | "/usages", signal?: AbortSignal): Promise<unknown> {
		const controller = new AbortController();
		const cancel = () => controller.abort();
		if (signal?.aborted) cancel();
		signal?.addEventListener("abort", cancel, { once: true });
		const timer = setTimeout(cancel, 10_000);
		try {
			const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
				headers: { ...this.headers, Accept: "application/json" },
				signal: controller.signal,
				redirect: "error",
			});
			if (!response.ok) {
				// Do not log arbitrary response bodies: proxies may echo credentials.
				throw new KimiApiError(`Metadata request failed (HTTP ${response.status}).`, response.status);
			}
			return await response.json();
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
		}
	}

	async *streamChat(
		model: string,
		messages: KimiMessage[],
		baseUrl: string,
		options?: ChatOptions,
		cancellationToken?: vscode.CancellationToken,
		signal?: AbortSignal,
	): AsyncGenerator<KimiStreamChunk> {
		const cancellation = requestCancellation(cancellationToken, signal);
		try {
			const response = await this.sendRequest(model, messages, baseUrl, true, options, cancellation.signal);

			if (!response.body) {
				throw new KimiApiError("No response body", 0);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let sawDataEvent = false;
			let sawDoneMarker = false;
			const strictSseDone =
				options?.requireSseDoneMarker !== false;

			try {
				while (true) {
					if (cancellationToken?.isCancellationRequested) {
						await reader.cancel();
						break;
					}

					const { done, value } = await reader.read();
					buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = done ? "" : lines.pop() || "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed || !trimmed.startsWith("data:")) continue;

						const data = trimmed.slice(5).trim();
						if (data === "[DONE]") {
							sawDoneMarker = true;
							return;
						}

						sawDataEvent = true;
						try {
							yield JSON.parse(data) as KimiStreamChunk;
						} catch {
							console.warn("Malformed SSE chunk skipped.");
						}
					}
					if (done) break;
				}

				if (
					strictSseDone &&
					!cancellationToken?.isCancellationRequested &&
					sawDataEvent &&
					!sawDoneMarker
				) {
					throw new KimiApiError(
						"Stream ended without a data: [DONE] chunk; the response may be incomplete (see Kimi streaming API documentation).",
						0,
					);
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		} finally {
			cancellation.dispose();
		}
	}

	async chat(
		model: string,
		messages: KimiMessage[],
		baseUrl: string,
		options?: ChatOptions,
		cancellationToken?: vscode.CancellationToken,
		signal?: AbortSignal,
	): Promise<KimiResponse> {
		const cancellation = requestCancellation(cancellationToken, signal);
		try {
			const response = await this.sendRequest(model, messages, baseUrl, false, options, cancellation.signal);
			return await response.json() as KimiResponse;
		} finally {
			cancellation.dispose();
		}
	}

	private buildRequestBody(
		model: string,
		messages: KimiMessage[],
		stream: boolean,
		options?: ChatOptions,
	): string {
		const thinking = options?.thinking ?? false;
		const body: Record<string, unknown> = {
			model,
			messages,
			stream,
		};
		if (options?.thinkingParameter ?? true) {
			body.thinking = thinking
				? { type: "enabled", keep: "all" }
				: { type: "disabled" };
		}
		if (stream) {
			body.stream_options = { include_usage: true };
		}

		if (options?.topP !== undefined) {
			body.top_p = options.topP;
		}
		if (thinking && options?.reasoningEffort !== undefined) {
			body.reasoning_effort = options.reasoningEffort;
		}
		if (options?.maxTokens !== undefined) {
			body.max_completion_tokens = options.maxTokens;
		}
		if (options?.tools !== undefined) {
			body.tools = options.tools;
		}
		if (options?.stop !== undefined) {
			body.stop = options.stop;
		}
		if (options?.promptCacheKey) {
			body.prompt_cache_key = options.promptCacheKey;
		}
		if (options?.toolMode === vscode.LanguageModelChatToolMode.Auto) {
			body.tool_choice = "auto";
		} else if (options?.toolMode === vscode.LanguageModelChatToolMode.Required) {
			body.tool_choice = (options.requiredToolChoice ?? true) ? "required" : "auto";
		}

		return JSON.stringify(body);
	}

	private async sendRequest(
		model: string,
		messages: KimiMessage[],
		baseUrl: string,
		stream: boolean,
		options?: ChatOptions,
		signal?: AbortSignal,
	): Promise<Response> {
		const body = this.buildRequestBody(model, messages, stream, options);
		const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
		for (let attempt = 0; ; attempt++) {
			const response = await fetch(`${baseUrl}${CHAT_ENDPOINT}`, {
				method: "POST",
				headers: this.headers,
				body,
				signal,
			});

			if (response.ok) {
				return response;
			}

			const delay = attempt < maxRetries && RETRYABLE_STATUSES.has(response.status)
				? retryDelayMs(attempt, response.headers.get("retry-after"))
				: undefined;
			if (delay === undefined) {
				const errorBody = await this.parseErrorBody(response);
				throw new KimiApiError(
					`Kimi API error: ${response.status} ${response.statusText}`,
					response.status,
					errorBody,
				);
			}

			await response.body?.cancel().catch(() => {});
			options?.onRetry?.(response.status, delay, attempt + 1);
			await sleep(delay, signal);
		}
	}

	private async parseErrorBody(response: Response): Promise<unknown> {
		const errorText = await response.text();
		try {
			return JSON.parse(errorText);
		} catch {
			return errorText;
		}
	}
}

/**
 * Delay before retry number `attempt + 1`: the server's Retry-After when present,
 * otherwise exponential backoff (1s, 2s, 4s) with jitter. Undefined means do not retry.
 */
export function retryDelayMs(attempt: number, retryAfter: string | null, now = Date.now()): number | undefined {
	if (retryAfter?.trim()) {
		const seconds = Number(retryAfter);
		const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
		if (Number.isFinite(delay)) {
			return delay > MAX_RETRY_DELAY_MS ? undefined : Math.max(0, Math.ceil(delay));
		}
	}
	const backoff = BASE_RETRY_DELAY_MS * 2 ** attempt;
	return Math.round(backoff + Math.random() * backoff * 0.25);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function requestCancellation(token?: vscode.CancellationToken, signal?: AbortSignal) {
	const controller = new AbortController();
	if (token?.isCancellationRequested) controller.abort();
	const listener = token?.onCancellationRequested(() => controller.abort());
	return {
		signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
		dispose: () => listener?.dispose(),
	};
}
