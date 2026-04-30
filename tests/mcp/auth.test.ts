import { describe, it, expect } from "vitest";
import {
	generateToken,
	extractBearerToken,
	safeCompare,
	isAuthorized,
} from "../../src/mcp/auth";

describe("generateToken", () => {
	it("returns a 64-char hex string (32 bytes)", () => {
		const t = generateToken();
		expect(t).toMatch(/^[0-9a-f]{64}$/);
	});

	it("returns a different value on each call", () => {
		const set = new Set([
			generateToken(),
			generateToken(),
			generateToken(),
			generateToken(),
		]);
		expect(set.size).toBe(4);
	});
});

describe("extractBearerToken", () => {
	it("parses `Bearer <token>` (case-insensitive)", () => {
		expect(extractBearerToken("Bearer abc123")).toBe("abc123");
		expect(extractBearerToken("bearer abc123")).toBe("abc123");
		expect(extractBearerToken("BEARER abc123")).toBe("abc123");
	});

	it("trims surrounding whitespace", () => {
		expect(extractBearerToken("  Bearer   abc123  ")).toBe("abc123");
	});

	it("accepts a bare token (no Bearer prefix)", () => {
		expect(extractBearerToken("abc123")).toBe("abc123");
	});

	it("returns null for missing or empty input", () => {
		expect(extractBearerToken(undefined)).toBeNull();
		expect(extractBearerToken("")).toBeNull();
		expect(extractBearerToken("   ")).toBeNull();
		expect(extractBearerToken("Bearer ")).toBeNull();
	});

	it("uses the first value when an array is supplied", () => {
		expect(extractBearerToken(["Bearer abc", "Bearer def"])).toBe("abc");
	});
});

describe("safeCompare", () => {
	it("returns true for identical non-empty strings", () => {
		expect(safeCompare("abc123", "abc123")).toBe(true);
	});

	it("returns false for different strings of equal length", () => {
		expect(safeCompare("abc123", "xyz789")).toBe(false);
	});

	it("returns false for length mismatch (no throw)", () => {
		expect(safeCompare("abc", "abcd")).toBe(false);
	});

	it("returns false for empty strings", () => {
		expect(safeCompare("", "")).toBe(false);
		expect(safeCompare("abc", "")).toBe(false);
	});

	it("returns false for non-string input", () => {
		expect(safeCompare(undefined as any, "abc")).toBe(false);
		expect(safeCompare("abc", null as any)).toBe(false);
	});
});

describe("isAuthorized", () => {
	it("authorizes when expected and presented match", () => {
		const tok = generateToken();
		expect(isAuthorized(tok, tok)).toBe(true);
	});

	it("rejects mismatched tokens", () => {
		expect(isAuthorized(generateToken(), generateToken())).toBe(false);
	});

	it("rejects empty/missing presented token", () => {
		const tok = generateToken();
		expect(isAuthorized(tok, null)).toBe(false);
		expect(isAuthorized(tok, undefined)).toBe(false);
		expect(isAuthorized(tok, "")).toBe(false);
	});

	it("rejects when expected is empty (auth not configured)", () => {
		expect(isAuthorized("", "anything")).toBe(false);
	});
});
