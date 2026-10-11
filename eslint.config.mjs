import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
	// The proposed API typings are copied verbatim from VS Code.
	{ ignores: ["out/", "node_modules/", "docs/", "src/vscode.proposed.*.d.ts"] },
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: { globals: globals.node },
		rules: {
			// The manifest lives outside rootDir, so it is loaded at runtime.
			"@typescript-eslint/no-require-imports": ["error", { allow: ["/package\\.json$"] }],
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"@stylistic/quotes": ["error", "double", { avoidEscape: true, allowTemplateLiterals: "always" }],
		},
	},
	{
		files: ["**/*.cjs"],
		languageOptions: { sourceType: "commonjs", globals: globals.node },
		rules: {
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		},
	},
	{
		plugins: { "@stylistic": stylistic },
		rules: {
			"@stylistic/indent": ["error", "tab", { SwitchCase: 1 }],
			"@stylistic/no-mixed-spaces-and-tabs": "error",
			"@stylistic/no-trailing-spaces": "error",
			"@stylistic/eol-last": "error",
			"@stylistic/semi": "error",
		},
	},
);
