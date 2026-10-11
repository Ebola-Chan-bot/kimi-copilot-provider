const assert = require('node:assert/strict');
const { test, after, afterEach } = require('node:test');
const Module = require('node:module');
const originalLoad = Module._load;
const originalFetch = global.fetch;
const vscode = {
	version: '1.120.0',
	l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) },
	workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
	LanguageModelChatToolMode: { Auto: 1, Required: 2 },
};
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
const { KimiApiClient, KimiApiError, retryDelayMs } = require('../out/api.js');
after(() => { Module._load = originalLoad; });
afterEach(() => { global.fetch = originalFetch; });

const base = 'https://api.kimi.ai/coding/v1';
const messages = [{ role: 'user', content: 'hi' }];
const ok = () => new Response(JSON.stringify({ choices: [{ index: 0, message: { content: 'OK' }, finish_reason: 'stop' }] }));
const fail = status => new Response('busy', { status, headers: { 'Retry-After': '0' } });

function respond(...responses) {
	const calls = [];
	global.fetch = async (url, init) => { calls.push({ url, init }); return responses[calls.length - 1](); };
	return calls;
}

test('retries 429 and 5xx responses, then returns the successful response', async () => {
	const retries = [];
	const calls = respond(() => fail(429), () => fail(503), ok);
	const response = await new KimiApiClient('key').chat('m', messages, base, {
		onRetry: (status, delay, attempt) => retries.push([status, delay, attempt]),
	});
	assert.equal(response.choices[0].message.content, 'OK');
	assert.equal(calls.length, 3);
	assert.deepEqual(retries, [[429, 0, 1], [503, 0, 2]]);
	assert.equal(calls[0].init.body, calls[2].init.body);
});

test('gives up after three retries and reports the last error', async () => {
	const calls = respond(() => fail(502), () => fail(502), () => fail(502), () => fail(500));
	await assert.rejects(new KimiApiClient('key').chat('m', messages, base), error =>
		error instanceof KimiApiError && error.statusCode === 500 && error.response === 'busy');
	assert.equal(calls.length, 4);
});

test('does not retry client errors, disabled retries or long Retry-After waits', async () => {
	let calls = respond(() => fail(400));
	await assert.rejects(new KimiApiClient('key').chat('m', messages, base), { statusCode: 400 });
	assert.equal(calls.length, 1);

	calls = respond(() => fail(429));
	await assert.rejects(new KimiApiClient('key').chat('m', messages, base, { maxRetries: 0 }), { statusCode: 429 });
	assert.equal(calls.length, 1);

	calls = respond(() => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
	await assert.rejects(new KimiApiClient('key').chat('m', messages, base), { statusCode: 429 });
	assert.equal(calls.length, 1);
});

test('backoff doubles from one second and honors Retry-After seconds and dates', () => {
	for (const [attempt, min] of [[0, 1000], [1, 2000], [2, 4000]]) {
		const delay = retryDelayMs(attempt, null);
		assert.ok(delay >= min && delay <= min * 1.25, `attempt ${attempt}: ${delay}`);
	}
	assert.equal(retryDelayMs(0, '3'), 3000);
	assert.equal(retryDelayMs(0, new Date(10_000).toUTCString(), 5_000), 5000);
	assert.equal(retryDelayMs(0, '31'), undefined);
	assert.ok(retryDelayMs(1, 'not a date') >= 2000);
});

test('cancellation during a backoff wait stops further attempts', async () => {
	const calls = respond(() => new Response('', { status: 503, headers: { 'Retry-After': '10' } }), ok);
	const controller = new AbortController();
	const pending = new KimiApiClient('key').chat('m', messages, base, {
		onRetry: () => setImmediate(() => controller.abort()),
	}, undefined, controller.signal);
	await assert.rejects(pending, { name: 'AbortError' });
	assert.equal(calls.length, 1);
});
