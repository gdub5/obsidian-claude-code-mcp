import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(__dirname, "tests/mocks/obsidian.ts"),
		},
	},
	// esbuild injects this at production-build time; stub it for tests so
	// any module that references it doesn't blow up at evaluation.
	define: {
		__BUILD_STAMP__: JSON.stringify("test"),
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/terminal/**",
				"src/**/*.d.ts",
			],
		},
	},
});
