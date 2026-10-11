const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = {
	version: '1.120.0',
	l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) },
	workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
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
const { convertMessages, toolResultContent } = require('../out/messages.js');
after(() => { Module._load = originalLoad; });

const text = value => new vscode.LanguageModelTextPart(value);
const data = (value, mimeType) => new vscode.LanguageModelDataPart(new TextEncoder().encode(value), mimeType);

test('tool results send the text itself, not a JSON envelope around text parts', () => {
	const messages = convertMessages([
		{ role: 2, content: [new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a.ts' })] },
		{ role: 1, content: [new vscode.LanguageModelToolResultPart('call-1', [text('line 1\n'), text('line "2"')])] },
	], false);
	assert.deepEqual(messages[1], { role: 'tool', content: 'line 1\nline "2"', tool_call_id: 'call-1' });
});

test('tool result data parts decode text, skip cache markers and describe binary attachments', () => {
	assert.equal(toolResultContent([data('{"ok":true}', 'application/json'), data('ephemeral', 'cache_control')]), '{"ok":true}');
	assert.equal(toolResultContent([data('PNG', 'image/png')]), '\n[Tool result attachment omitted: image/png, 3 bytes]\n');
	assert.equal(toolResultContent('legacy string'), 'legacy string');
	assert.equal(toolResultContent([{ unknown: 1 }]), '{"unknown":1}');
});

test('cache_control markers in user messages are not sent as omitted attachments', () => {
	const [message] = convertMessages([{ role: 1, content: [text('hello'), data('ephemeral', 'cache_control')] }], false);
	assert.deepEqual(message, { role: 'user', content: 'hello', name: undefined });
});
