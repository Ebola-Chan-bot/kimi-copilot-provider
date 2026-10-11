import * as vscode from "vscode";
import { KimiApiClient } from "./api";
import { metadataError } from "./catalog";
import { record } from "./models";

export interface UsageEntry { usedRatio: number; resetAt?: string }
export interface Usage { fiveHour?: UsageEntry; weekly?: UsageEntry }
export interface Account { apiKey: string; baseUrl: string }

export function parseUsage(payload: unknown): Usage {
	const usages = record(record(payload)?.usages);
	if (!usages) throw new Error("Invalid usage response.");
	const entry = (value: unknown): UsageEntry | undefined => {
		const raw = record(value);
		const ratio = raw?.used_ratio;
		if (typeof ratio !== "number" && (typeof ratio !== "string" || !ratio.trim())) return undefined;
		const number = Number(ratio);
		if (!Number.isFinite(number) || number < 0) return undefined;
		const reset = raw?.reset_time;
		return { usedRatio: number, resetAt: typeof reset === "string" && Number.isFinite(Date.parse(reset)) ? reset : undefined };
	};
	const result = { fiveHour: entry(usages.limit_5h), weekly: entry(usages.limit_7d) };
	if (!result.fiveHour && !result.weekly) throw new Error("No supported usage windows.");
	return result;
}

function formatElapsed(milliseconds: number): string {
	const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor(minutes % 1440 / 60);
	if (days) return `${days}d${hours ? ` ${hours}h` : ""}`;
	if (hours) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
	return `${minutes}m`;
}

function formatReset(resetAt: string, now: number): string {
	const remaining = Date.parse(resetAt) - now;
	if (remaining <= 0) return vscode.l10n.t("Reset time reached · awaiting update");
	return vscode.l10n.t("Resets in {0}", remaining < 60_000 ? "<1m" : formatElapsed(remaining));
}

function formatLocalTime(date: Date): string {
	return date.toLocaleString(vscode.env.language, { timeZoneName: "short" });
}

function usageBar(ratio: number): string {
	const filled = Math.min(ratio < 1 ? 9 : 10, Math.round(Math.max(0, ratio) * 10));
	return "■".repeat(filled) + "□".repeat(10 - filled);
}

export class UsageStatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
	private account: Account | undefined;
	private enabled = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private controller: AbortController | undefined;
	private flight: Promise<void> | undefined;
	private generation = 0;
	private usage: Usage | undefined;
	private updatedAt: Date | undefined;
	private error: string | undefined;
	private disposed = false;

	constructor(private readonly log: (message: string) => void) {
		this.item.name = vscode.l10n.t("Kimi Code Usage");
		this.item.command = "kimi.usageActions";
	}

	configure(account: Account | undefined, enabled: boolean): void {
		if (this.disposed) return;
		if (this.account?.apiKey === account?.apiKey && this.account?.baseUrl === account?.baseUrl && this.enabled === enabled) return;
		this.stop();
		this.account = account;
		this.enabled = enabled;
		this.usage = undefined;
		this.updatedAt = undefined;
		this.error = undefined;
		if (!account || !enabled) { this.item.hide(); return; }
		this.item.show();
		void this.refresh();
		this.timer = setInterval(() => { void this.refresh(); }, 60_000);
	}

	refresh(): Promise<void> {
		if (!this.account || !this.enabled || this.disposed) return Promise.resolve();
		if (this.flight) return this.flight;
		const generation = this.generation;
		const account = this.account;
		const controller = this.controller = new AbortController();
		this.render(true);
		this.flight = (async () => {
			try {
				const payload = await new KimiApiClient(account.apiKey).getMetadata(account.baseUrl, "/usages", controller.signal);
				const usage = parseUsage(payload);
				if (generation !== this.generation) return;
				this.usage = usage;
				this.updatedAt = new Date();
				this.error = undefined;
			} catch (error) {
				if (generation !== this.generation) return;
				this.error = metadataError(error);
				this.log(`Usage: ${this.error}`);
			} finally {
				if (generation === this.generation) {
					this.flight = undefined;
					this.render(false);
				}
			}
		})();
		return this.flight;
	}

	private render(loading: boolean): void {
		const now = Date.now();
		const percent = (entry?: UsageEntry) => entry ? `${Math.round(entry.usedRatio * 100)}%` : "—";
		const icon = loading ? "$(sync~spin)" : "$(dashboard)";
		this.item.text = this.usage
			? `${icon} Kimi · 5h ${percent(this.usage.fiveHour)} · 7d ${percent(this.usage.weekly)}${this.error ? " $(warning)" : ""}`
			: loading ? `${icon} ${vscode.l10n.t("Kimi · Loading usage")}` : `$(warning) ${vscode.l10n.t("Kimi · Usage unavailable")}`;

		const tooltip = new vscode.MarkdownString("", true);
		tooltip.isTrusted = { enabledCommands: ["kimi.refreshUsage"] };
		tooltip.appendMarkdown(`$(dashboard) **${vscode.l10n.t("Kimi Code Usage")}**\n\n${vscode.l10n.t("Account quota · percentage used")}\n\n`);
		const accessible = [vscode.l10n.t("Kimi Code Usage. Account quota, percentage used.")];
		const windows = [
			[vscode.l10n.t("5-hour limit"), this.usage?.fiveHour],
			[vscode.l10n.t("Weekly limit"), this.usage?.weekly],
		] as const;
		for (const [label, entry] of windows) {
			const value = entry ? vscode.l10n.t("{0} used", percent(entry)) : vscode.l10n.t("— · Unavailable");
			tooltip.appendMarkdown(`**${label} · ${value}**\n\n`);
			accessible.push(`${label}: ${entry ? value : vscode.l10n.t("unavailable")}.`);
			if (entry) tooltip.appendMarkdown(`\`${usageBar(entry.usedRatio)}\`\n\n`);
			if (entry?.resetAt) {
				const reset = formatReset(entry.resetAt, now);
				const localTime = formatLocalTime(new Date(entry.resetAt));
				tooltip.appendText(reset);
				tooltip.appendMarkdown("  \n");
				const resetAt = vscode.l10n.t("Reset: {0}", localTime);
				tooltip.appendText(resetAt);
				tooltip.appendMarkdown("\n\n");
				accessible.push(`${reset}. ${resetAt}.`);
			}
		}
		tooltip.appendMarkdown("---\n\n");
		const elapsed = this.updatedAt ? now - this.updatedAt.getTime() : undefined;
		const updated = elapsed === undefined ? vscode.l10n.t("No successful update yet")
			: elapsed < 60_000 ? vscode.l10n.t("Updated just now") : vscode.l10n.t("Updated {0} ago", formatElapsed(elapsed));
		tooltip.appendText(vscode.l10n.t("{0} · Every 60s", updated));
		tooltip.appendMarkdown("\n\n");
		accessible.push(vscode.l10n.t("{0}. Refreshes every 60 seconds.", updated));
		if (this.updatedAt) {
			const lastSuccess = vscode.l10n.t("Last success: {0}", formatLocalTime(this.updatedAt));
			tooltip.appendText(lastSuccess);
			tooltip.appendMarkdown("\n\n");
			accessible.push(`${lastSuccess}.`);
		}
		if (this.error) {
			const state = this.usage ? vscode.l10n.t("Stale · Refresh failed") : vscode.l10n.t("Usage unavailable · Refresh failed");
			const detail = vscode.l10n.t("{0}. Chat requests are unaffected.", this.error);
			tooltip.appendMarkdown(`$(warning) **${state}**  \n`);
			tooltip.appendText(detail);
			tooltip.appendMarkdown("\n\n");
			accessible.push(`${state}. ${detail}`);
		}
		if (loading) {
			tooltip.appendMarkdown(`$(sync~spin) ${vscode.l10n.t("Refreshing…")}\n\n`);
			accessible.push(vscode.l10n.t("Refreshing."));
		}
		tooltip.appendMarkdown(`[$(refresh) ${vscode.l10n.t("Refresh")}](command:kimi.refreshUsage) · [$(link-external) ${vscode.l10n.t("Open Console")}](https://www.kimi.com/code/console)`);
		accessible.push(vscode.l10n.t("Click for Refresh Usage or Open Kimi Console."));
		this.item.tooltip = tooltip;
		this.item.accessibilityInformation = { label: accessible.join(" ") };
	}

	private stop(): void {
		this.generation++;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.controller?.abort();
		this.controller = undefined;
		this.flight = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.item.dispose();
	}
}
