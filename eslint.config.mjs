import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "vitest.config.ts", "scripts/*.mjs"],
				},
			},
		},
	},
	{
		ignores: ["main.js", "node_modules/**", "**/*.d.ts"],
	},
	{
		// Node-only dev tooling (vault linking, hot-reload install) - never runs inside Obsidian,
		// so the runtime-focused obsidianmd rules (fetch vs requestUrl, console, config paths) don't apply.
		files: ["scripts/**/*.mjs"],
		rules: {
			"no-restricted-globals": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"obsidianmd/rule-custom-message": "off",
		},
	},
	{
		// The rule's casing pass flags legitimate brand names (Whisper, OpenRouter, OpenAI) and
		// placeholder tokens (sk-...) as violations - "fixing" them to its suggested casing would
		// make the copy wrong, not better.
		files: ["src/settings.ts"],
		rules: {
			"obsidianmd/ui/sentence-case": "off",
		},
	},
]);
