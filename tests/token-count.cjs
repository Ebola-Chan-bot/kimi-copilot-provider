const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = {
	LanguageModelTextPart: class { constructor(value) { this.value = value; } },
	LanguageModelDataPart: class {
		constructor(data, mimeType) { Object.assign(this, { data, mimeType }); }
	},
	LanguageModelToolCallPart: class {
		constructor(callId, name, input) { Object.assign(this, { callId, name, input }); }
	},
	LanguageModelToolResultPart: class {
		constructor(callId, content) { Object.assign(this, { callId, content }); }
	},
};
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
const { estimateTokenCount, estimateRequestTokens } = require('../out/tokenCount.js');
after(() => { Module._load = originalLoad; });

const text = value => new vscode.LanguageModelTextPart(value);

test('Latin text keeps four characters per token; CJK counts one per character', () => {
	assert.equal(estimateTokenCount('a'.repeat(400)), 100);
	assert.equal(estimateTokenCount('上下文窗口'), 5);
	assert.equal(estimateTokenCount('上下文 window'), 5); // 3 CJK + 7 Latin chars / 4, rounded up
	assert.equal(estimateTokenCount('𠀀'), 1); // astral Han is one character, not two
});

test('tool calls and tool results are counted, not just text parts', () => {
	const call = { role: 2, content: [new vscode.LanguageModelToolCallPart('c1', 'read_file', { path: 'x'.repeat(400) })] };
	const result = { role: 1, content: [new vscode.LanguageModelToolResultPart('c1', [text('y'.repeat(4000))])] };
	assert.ok(estimateTokenCount(call) > 100);
	assert.ok(estimateTokenCount(result) >= 1000);
});

test('request estimate mirrors Copilot per-message and per-tool overheads', () => {
	const messages = [{ role: 1, content: [text('a'.repeat(40))] }, { role: 2, content: [text('b'.repeat(40))] }];
	assert.deepEqual(estimateRequestTokens(messages), { messages: 3 + 2 * (3 + 10), tools: 0, total: 29 });
	const tool = { name: 'read', description: 'd'.repeat(40), inputSchema: { type: 'object' } };
	// 16 + 8 + name(1+1) + description(3+10) + parameters(3 + type(1+2)), then +10%
	assert.equal(estimateRequestTokens([], [tool]).tools, Math.floor(1.1 * 45));
});
