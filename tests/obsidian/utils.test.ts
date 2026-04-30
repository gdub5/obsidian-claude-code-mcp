import { describe, it, expect } from "vitest";
import { normalizePath, getAbsolutePath } from "../../src/obsidian/utils";

describe("normalizePath", () => {
	it("returns vault-relative paths unchanged", () => {
		expect(normalizePath("notes/foo.md")).toBe("notes/foo.md");
	});

	it("strips a single leading slash", () => {
		expect(normalizePath("/notes/foo.md")).toBe("notes/foo.md");
	});

	it("rejects directory traversal via ..", () => {
		expect(normalizePath("../etc/passwd")).toBeNull();
		expect(normalizePath("notes/../../etc")).toBeNull();
	});

	it("rejects ~ for home expansion", () => {
		expect(normalizePath("~/secret")).toBeNull();
	});

	it("accepts an empty string", () => {
		expect(normalizePath("")).toBe("");
	});
});

describe("getAbsolutePath", () => {
	it("joins base and relative", () => {
		expect(getAbsolutePath("notes/foo.md", "/vault")).toBe(
			"/vault/notes/foo.md"
		);
	});
});
