import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(import.meta.dirname, "tests/__mocks__/obsidian.ts"),
		},
	},
});
