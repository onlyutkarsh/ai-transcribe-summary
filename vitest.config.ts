import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: [path.resolve(import.meta.dirname, "tests/setup.ts")],
	},
	resolve: {
		alias: {
			obsidian: path.resolve(import.meta.dirname, "tests/__mocks__/obsidian.ts"),
		},
	},
});
