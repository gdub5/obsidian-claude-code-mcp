import { describe, it, expect } from "vitest";
import {
	DEFAULT_SETTINGS,
	ensureAuthToken,
	type ClaudeCodeSettings,
} from "../src/settings";

function freshSettings(overrides: Partial<ClaudeCodeSettings> = {}): ClaudeCodeSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("ensureAuthToken", () => {
	it("generates a token when missing and reports the change", () => {
		const s = freshSettings({ mcpAuthToken: "" });
		const changed = ensureAuthToken(s);

		expect(changed).toBe(true);
		expect(s.mcpAuthToken).toMatch(/^[0-9a-f]{64}$/);
	});

	it("preserves an existing non-empty token", () => {
		const s = freshSettings({ mcpAuthToken: "preexisting-token-value" });
		const changed = ensureAuthToken(s);

		expect(changed).toBe(false);
		expect(s.mcpAuthToken).toBe("preexisting-token-value");
	});

	it("treats whitespace-only token as missing", () => {
		const s = freshSettings({ mcpAuthToken: "   " });
		const changed = ensureAuthToken(s);

		expect(changed).toBe(true);
		expect(s.mcpAuthToken.trim()).not.toBe("");
		expect(s.mcpAuthToken).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("DEFAULT_SETTINGS", () => {
	it("ships with an empty token (forces generation on first load)", () => {
		expect(DEFAULT_SETTINGS.mcpAuthToken).toBe("");
	});
});
