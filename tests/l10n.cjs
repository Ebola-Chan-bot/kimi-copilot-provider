const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const placeholders = message => [...message.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();

function runtimeMessages() {
	const messages = new Set();
	for (const file of fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.ts'))) {
		const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
		for (const match of source.matchAll(/vscode\.l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g)) {
			messages.add(JSON.parse(`"${match[1]}"`));
		}
	}
	return messages;
}

test('every runtime message has a zh-cn translation with the same placeholders', () => {
	const bundle = readJson('l10n/bundle.l10n.zh-cn.json');
	const messages = runtimeMessages();
	assert.ok(messages.size > 0);
	for (const message of messages) {
		assert.ok(message in bundle, `Missing zh-cn translation: ${message}`);
		assert.deepEqual(placeholders(bundle[message]), placeholders(message), message);
	}
	for (const message of Object.keys(bundle)) {
		assert.ok(messages.has(message), `Unused zh-cn translation: ${message}`);
	}
});

test('every package.json placeholder is defined in both manifest bundles', () => {
	const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
	const keys = [...manifest.matchAll(/"%([^%"]+)%"/g)].map(match => match[1]);
	assert.ok(keys.length > 0);
	for (const file of ['package.nls.json', 'package.nls.zh-cn.json']) {
		const bundle = readJson(file);
		assert.deepEqual(Object.keys(bundle).sort(), [...new Set(keys)].sort(), file);
	}
});
