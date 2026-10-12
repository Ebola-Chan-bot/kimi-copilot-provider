const assert = require('node:assert/strict');
const { test, after, afterEach } = require('node:test');
const Module = require('node:module');
const originalLoad = Module._load;
const originalFetch = global.fetch;
const settings = { endpoint: 'moonshot' };
const vscode = {
	version: '1.120.0',
	l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) },
	workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
	EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
	LanguageModelChatToolMode: { Auto: 1, Required: 2 },
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	LanguageModelDataPart: class { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } },
};
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
const { parseModels, serializeModels } = require('../out/models.js');
const { isMoonshotPlatform } = require('../out/config.js');
const { KimiChatProvider } = require('../out/provider.js');
after(() => { Module._load = originalLoad; });
afterEach(() => { global.fetch = originalFetch; });
const base = 'https://api.moonshot.ai/v1';
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
// Shape documented at https://platform.kimi.ai/docs/api/list-models.
const model = (id, context, reasoning) => ({
	id, object: 'model', created: 1, owned_by: 'moonshot', context_length: context,
	supports_image_in: true, supports_video_in: true, supports_reasoning: reasoning,
});
const catalog = { object: 'list', data: [
	model('kimi-k3', 1048576, true), model('kimi-k2.7-code', 262144, true),
	model('kimi-k2.7-code-highspeed', 262144, true), model('kimi-k2.6', 262144, true), model('kimi-k9', 131072, true),
] };
const tool = { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } };

test('Open Platform hosts are recognized only by hostname', () => {
	assert.equal(isMoonshotPlatform('https://api.moonshot.ai/v1'), true);
	assert.equal(isMoonshotPlatform('https://api.moonshot.cn/v1'), true);
	assert.equal(isMoonshotPlatform('https://api.kimi.ai/coding/v1'), false);
	assert.equal(isMoonshotPlatform('https://moonshot.ai.example.com/v1'), false);
	assert.equal(isMoonshotPlatform('not a url'), false);
});

test('Open Platform model list gets documented request constraints and tool calling', () => {
	const models = parseModels(catalog, base);
	const byId = Object.fromEntries(models.map(m => [m.id, m]));
	assert.deepEqual(byId['kimi-k3'], {
		id: 'kimi-k3', name: 'Kimi K3', family: 'kimi', version: 'kimi-k3', contextWindow: 1048576,
		tooltip: 'Kimi · discovered from API', thinking: true, thinkingType: 'only',
		supportsReasoningEffort: true, reasoningEfforts: ['low', 'high', 'max'], defaultEffort: 'max',
		requireSseDoneMarker: true, thinkingParameter: false, requiredToolChoice: true,
		capabilities: { imageInput: true, toolCalling: true },
	});
	for (const id of ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed']) {
		assert.equal(byId[id].thinkingType, 'only');
		assert.equal(byId[id].thinkingParameter, true);
		assert.equal(byId[id].requiredToolChoice, false);
		assert.equal(byId[id].supportsReasoningEffort, false);
	}
	assert.equal(byId['kimi-k2.6'].thinkingType, 'both');
	assert.equal(byId['kimi-k9'].thinkingParameter, false);
	assert.equal(byId['kimi-k9'].requiredToolChoice, false);
	assert.equal(byId['kimi-k9'].capabilities.toolCalling, true);
	assert.equal(byId['kimi-k9'].name, 'kimi-k9');
	assert.deepEqual(parseModels(serializeModels(models), base), models);
	// Kimi Code parsing is unchanged: no Open Platform defaults on other hosts.
	const coding = parseModels({ data: [{ id: 'kimi-k3' }] }, 'https://api.kimi.ai/coding/v1')[0];
	assert.equal(coding.capabilities.toolCalling, false);
	assert.equal(Object.hasOwn(coding, 'thinkingParameter'), false);
});

test('request bodies follow each Open Platform model\'s parameter rules', async () => {
	const bodies = [];
	let sse = 'data: [DONE]\n\n';
	global.fetch = async (url, init) => {
		if (url === `${base}/models`) return new Response(JSON.stringify(catalog));
		assert.equal(url, `${base}/chat/completions`);
		bodies.push(JSON.parse(init.body));
		return new Response(sse);
	};
	const provider = new KimiChatProvider();
	try {
		const models = await provider.provideLanguageModelChatInformation({ modelConfiguration: { apiKey: 'test-only' } }, token);
		assert.equal(models.find(m => m.id === 'kimi-k3').capabilities.toolCalling, true);
		const send = async (id, options = {}) => {
			const parts = [];
			await provider.provideLanguageModelChatResponse(models.find(m => m.id === id), [],
				{ tools: [tool], toolMode: vscode.LanguageModelChatToolMode.Required, ...options }, { report: p => parts.push(p) }, token);
			return { body: bodies.at(-1), parts };
		};

		let { body } = await send('kimi-k3', { modelConfiguration: { reasoningEffort: 'low' } });
		assert.equal(Object.hasOwn(body, 'thinking'), false);
		assert.equal(body.reasoning_effort, 'low');
		assert.equal(body.tool_choice, 'required');
		assert.equal(Object.hasOwn(body, 'top_p'), false);
		assert.equal(Object.hasOwn(body, 'temperature'), false);

		({ body } = await send('kimi-k2.7-code', { modelOptions: { thinkingMode: 'disabled' } }));
		assert.deepEqual(body.thinking, { type: 'enabled', keep: 'all' });
		assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
		assert.equal(body.tool_choice, 'auto');

		({ body } = await send('kimi-k2.6', { modelOptions: { thinkingMode: 'disabled' } }));
		assert.deepEqual(body.thinking, { type: 'disabled' });
		assert.equal(body.tool_choice, 'auto');

		({ body } = await send('kimi-k9'));
		assert.equal(Object.hasOwn(body, 'thinking'), false);
		assert.equal(body.tool_choice, 'auto');

		// Usage nested in choices[0] (as in some Open Platform examples) is still reported.
		const usage = { prompt_tokens: 19, completion_tokens: 13, total_tokens: 32 };
		sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop', usage }] })}\n\ndata: [DONE]\n\n`;
		const { parts } = await send('kimi-k3');
		const reported = parts.filter(p => p.mimeType === 'usage').map(p => JSON.parse(new TextDecoder().decode(p.data)));
		assert.deepEqual(reported, [usage]);
	} finally { provider.dispose(); }
});

test('401 on the Open Platform points to platform keys, not the Kimi Code console', async () => {
	global.fetch = async url => url === `${base}/models`
		? new Response(JSON.stringify(catalog))
		: new Response(JSON.stringify({ error: { message: 'Invalid Authentication' } }), { status: 401 });
	const provider = new KimiChatProvider();
	try {
		const models = await provider.provideLanguageModelChatInformation({ modelConfiguration: { apiKey: 'test-only' } }, token);
		await assert.rejects(
			provider.provideLanguageModelChatResponse(models[0], [], {}, { report() {} }, token),
			error => /platform\.kimi\.ai/.test(error.message) && !/kimi\.com\/code\/console/.test(error.message),
		);
	} finally { provider.dispose(); }
});
