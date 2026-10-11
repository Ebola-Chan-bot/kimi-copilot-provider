#!/usr/bin/env node
/*
 * Compares the extension's token estimate (what VS Code budgets context with)
 * against the server's prompt_tokens, using the compiled extension code.
 *
 *   pnpm compile
 *   KIMI_API_KEY=... node scripts/token-calibration.cjs [options]
 *
 * Options:
 *   --model <id>        model ID (default kimi-for-coding)
 *   --base-url <url>    API base URL (default $KIMI_BASE_URL or https://api.kimi.ai/coding/v1)
 *   --size <tokens>     estimated tokens per ratio sample (default 8000)
 *   --probe <tokens>    instead of the ratio table, send one Agent-like request whose
 *                       estimate is about <tokens>, e.g. 229376 (the advertised input limit)
 *   --max-tokens <n>    max_completion_tokens to send (default 1; use 32768 to test
 *                       whether the server also reserves the output budget)
 *   --context <tokens>  context window to compare against (default 262144)
 *   --thinking          send thinking enabled (for thinking-only models)
 *
 * Each request is billed: the probe costs about <tokens> input tokens.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const vscode = {
	version: 'calibration',
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	LanguageModelDataPart: class { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } },
	LanguageModelToolCallPart: class { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } },
	LanguageModelToolResultPart: class { constructor(callId, content) { Object.assign(this, { callId, content }); } },
};
const originalLoad = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
let estimateRequestTokens, convertMessages, convertTools;
try {
	({ estimateRequestTokens } = require('../out/tokenCount.js'));
	({ convertMessages, convertTools } = require('../out/messages.js'));
} catch {
	console.error('Compiled output not found; run `pnpm compile` first.');
	process.exit(1);
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(name);
	return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const apiKey = process.env.KIMI_API_KEY;
const baseUrl = option('--base-url', process.env.KIMI_BASE_URL ?? 'https://api.kimi.ai/coding/v1').replace(/\/+$/, '');
const model = option('--model', 'kimi-for-coding');
const size = Number(option('--size', '8000'));
const probe = args.includes('--probe') ? Number(option('--probe', '229376')) : undefined;
const maxTokens = Number(option('--max-tokens', '1'));
const context = Number(option('--context', '262144'));
const thinking = args.includes('--thinking');
if (!apiKey) {
	console.error('Set KIMI_API_KEY.');
	process.exit(1);
}

const version = require('../package.json').version;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const text = value => new vscode.LanguageModelTextPart(value);
const user = value => ({ role: 1, content: [text(value)] });

const english = read('README.md');
const chineseMixed = read('README.zh-CN.md');
const chinese = (chineseMixed.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g) ?? []).join('');
const code = fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.ts')).map(f => read(`src/${f}`)).join('\n');
const json = JSON.stringify(require('../package.json').contributes, null, '\t');

// Tool schemas shaped like Copilot's: long descriptions, nested JSON Schema.
const tools = english.split(/\n\n+/).filter(p => p.length > 200).slice(0, 24).map((description, i) => ({
	name: `tool_${i}`,
	description,
	inputSchema: {
		type: 'object',
		properties: {
			filePath: { type: 'string', description: 'Absolute path of the file to operate on.' },
			startLine: { type: 'number', description: 'First line, 1-based.' },
			options: { type: 'object', properties: { recursive: { type: 'boolean' } } },
		},
		required: ['filePath'],
	},
}));

/** One Agent round: Chinese request, assistant tool call, code tool result. */
function agentRound(i) {
	return [
		user(`第 ${i} 轮：${chinese.slice((i * 200) % 4000, (i * 200) % 4000 + 200)}`),
		{ role: 2, content: [text('Reading the file.'), new vscode.LanguageModelToolCallPart(`call_${i}`, 'tool_0', { filePath: `/src/file${i}.ts`, startLine: 1 })] },
		{ role: 1, content: [new vscode.LanguageModelToolResultPart(`call_${i}`, [text(code.slice((i * 3000) % code.length, (i * 3000) % code.length + 3000))])] },
	];
}

/** Repeats `source` until a single user message estimates at about `target` tokens. */
function sample(source, target) {
	let body = source;
	while (estimateRequestTokens([user(body)]).total < target) body += '\n' + source;
	let low = 0, high = body.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (estimateRequestTokens([user(body.slice(0, mid))]).total <= target) low = mid; else high = mid - 1;
	}
	return [user(body.slice(0, low))];
}

function agentConversation(target, withTools) {
	const messages = [user('You are a coding agent. 请用中文回答。')];
	const toolList = withTools ? tools : [];
	for (let i = 0; estimateRequestTokens(messages, toolList).total < target; i++) messages.push(...agentRound(i));
	while (messages.length > 1 && estimateRequestTokens(messages, toolList).total > target) messages.pop();
	// End on a user turn so the request is well-formed.
	while (messages.length > 1 && messages.at(-1).role !== 1) messages.pop();
	return messages;
}

async function send(messages, toolList = []) {
	const body = {
		model,
		messages: convertMessages(messages, thinking),
		stream: false,
		thinking: thinking ? { type: 'enabled', keep: 'all' } : { type: 'disabled' },
		max_completion_tokens: maxTokens,
	};
	const kimiTools = convertTools(toolList);
	if (kimiTools) body.tools = kimiTools;
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
			'User-Agent': `kimi-lm-provider/${version} (token-calibration)`,
			'X-Msh-Platform': 'kimi-lm-provider',
			'X-Msh-Version': version,
		},
		body: JSON.stringify(body),
	});
	const raw = await response.text();
	let parsed;
	try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
	const actual = parsed?.usage?.prompt_tokens;
	if (!response.ok || typeof actual !== 'number') {
		return { error: `HTTP ${response.status}: ${raw.slice(0, 400)}` };
	}
	return { actual };
}

const pad = (value, width) => String(value).padStart(width);

async function ratioTable() {
	const baseline = [user('hi')];
	const base = await send(baseline);
	if (base.error) throw new Error(base.error);
	const baseEstimate = estimateRequestTokens(baseline).total;
	console.log(`model=${model} baseUrl=${baseUrl}`);
	console.log(`baseline "hi": estimate=${baseEstimate} actual=${base.actual} (fixed overhead subtracted below)\n`);
	console.log(`${'sample'.padEnd(16)}${pad('estimate', 10)}${pad('actual', 10)}${pad('actual/est', 12)}`);
	const cases = [
		['english', sample(english, size), []],
		['chinese', sample(chinese, size), []],
		['chinese-mixed', sample(chineseMixed, size), []],
		['code', sample(code, size), []],
		['json', sample(json, size), []],
		['tool-schemas', [user('hi')], tools],
		['agent', agentConversation(size, false), []],
		['agent+tools', agentConversation(size, true), tools],
	];
	for (const [name, messages, toolList] of cases) {
		const estimate = estimateRequestTokens(messages, toolList).total;
		const result = await send(messages, toolList);
		if (result.error) {
			console.log(`${name.padEnd(16)}${pad(estimate, 10)}  ${result.error}`);
			continue;
		}
		const ratio = (result.actual - base.actual) / Math.max(1, estimate - baseEstimate);
		console.log(`${name.padEnd(16)}${pad(estimate, 10)}${pad(result.actual, 10)}${pad(ratio.toFixed(2), 12)}`);
	}
	console.log('\nactual/est > 1 means VS Code underestimates that content: at a displayed N tokens the server sees about N × ratio.');
}

async function boundaryProbe() {
	const messages = agentConversation(probe, true);
	const estimate = estimateRequestTokens(messages, tools);
	console.log(`model=${model} baseUrl=${baseUrl}`);
	console.log(`probe: ${messages.length} messages, ${tools.length} tools, estimate=${estimate.total} (messages=${estimate.messages}, tools=${estimate.tools}), max_completion_tokens=${maxTokens}`);
	const result = await send(messages, tools);
	if (result.error) {
		console.log(`server rejected the request: ${result.error}`);
		return;
	}
	const fits = result.actual + maxTokens <= context;
	console.log(`server prompt_tokens=${result.actual} (actual/est=${(result.actual / estimate.total).toFixed(2)})`);
	console.log(`prompt + max_completion_tokens = ${result.actual + maxTokens} ${fits ? '<=' : '>'} context ${context}`);
}

(probe ? boundaryProbe() : ratioTable()).catch(error => {
	console.error(error.message);
	process.exit(1);
});
