import { describe, it, expect, vi } from "vitest";
import { App, Vault, TFile } from "../mocks/obsidian";
import { PluginTools } from "../../src/tools/plugin-tools";
import type { McpResponse } from "../../src/mcp/types";

// ──────────────────────────────────────────────────────────────────────
// Test harness

function makeReply() {
	const calls: Array<Omit<McpResponse, "jsonrpc" | "id">> = [];
	return { reply: (m: any) => calls.push(m), calls };
}

function setup() {
	const vault = new Vault();
	const app = new App(vault);
	return { app, vault };
}

const textOf = (call: any) => call.result?.content?.[0]?.text ?? "";
const handlerByName = (impls: any[], name: string) =>
	impls.find((i) => i.name === name)?.handler;

// ──────────────────────────────────────────────────────────────────────
// Plugin presence gating
//
// The whole point of the wrapper is that tools are NOT visible when
// their backing plugin is absent. These tests pin that contract.

describe("PluginTools — presence gating", () => {
	it("registers no tools when no community plugins are installed", () => {
		const { app } = setup();
		const tools = new PluginTools(app as any);
		expect(tools.getDefinitions()).toEqual([]);
		expect(tools.createImplementations()).toEqual([]);
	});

	it("registers only omnisearch when only Omnisearch is installed", () => {
		const { app } = setup();
		app.plugins.__seedPlugin("omnisearch", { search: vi.fn() });
		const tools = new PluginTools(app as any);
		const names = tools.getDefinitions().map((d) => d.name);
		expect(names).toEqual(["omnisearch"]);
		expect(tools.createImplementations().map((i) => i.name)).toEqual([
			"omnisearch",
		]);
	});

	it("registers all three when all three plugins are installed", () => {
		const { app } = setup();
		app.plugins.__seedPlugin("omnisearch", { search: vi.fn() });
		app.plugins.__seedPlugin("text-extractor", {
			canFileBeExtracted: vi.fn(),
			extractText: vi.fn(),
		});
		app.plugins.__seedPlugin("dataview", { queryMarkdown: vi.fn() });
		const tools = new PluginTools(app as any);
		expect(tools.getDefinitions().map((d) => d.name).sort()).toEqual([
			"dataview_query",
			"extract_text",
			"omnisearch",
		]);
	});

	it("definitions and implementations are name-aligned (registry contract)", () => {
		// dual-server.ts pairs definitions with implementations BY NAME.
		// If the two filters drift apart, registration would throw at
		// startup. Pin the pairing.
		const { app } = setup();
		app.plugins.__seedPlugin("omnisearch", { search: vi.fn() });
		app.plugins.__seedPlugin("dataview", { queryMarkdown: vi.fn() });
		const tools = new PluginTools(app as any);
		const defNames = tools.getDefinitions().map((d) => d.name).sort();
		const implNames = tools.createImplementations().map((i) => i.name).sort();
		expect(defNames).toEqual(implNames);
	});

	it("every definition carries proper safety annotations", () => {
		const { app } = setup();
		app.plugins.__seedPlugin("omnisearch", { search: vi.fn() });
		app.plugins.__seedPlugin("text-extractor", {
			canFileBeExtracted: vi.fn(),
			extractText: vi.fn(),
		});
		app.plugins.__seedPlugin("dataview", { queryMarkdown: vi.fn() });
		const tools = new PluginTools(app as any);
		for (const def of tools.getDefinitions()) {
			expect(def.annotations, `${def.name} missing annotations`).toBeDefined();
			expect(def.annotations?.readOnlyHint, `${def.name}.readOnlyHint`).toBe(
				true
			);
			expect(def.annotations?.destructiveHint).toBe(false);
			expect(def.annotations?.idempotentHint).toBe(true);
			expect(def.annotations?.openWorldHint).toBe(false);
		}
	});
});

// ──────────────────────────────────────────────────────────────────────
// omnisearch

describe("omnisearch", () => {
	function withOmnisearch(searchFn: any) {
		const { app, vault } = setup();
		app.plugins.__seedPlugin("omnisearch", { search: searchFn });
		const tools = new PluginTools(app as any);
		const handler = handlerByName(tools.createImplementations(), "omnisearch");
		return { app, vault, tools, handler };
	}

	it("formats results with score, path, and matched-word hints", async () => {
		const { handler } = withOmnisearch(async (q: string) => [
			{
				path: "notes/foo.md",
				score: 123.456,
				foundWords: ["foo", "fooo"],
				matches: [{}, {}, {}],
			},
			{
				path: "notes/bar.md",
				score: 87.2,
				foundWords: ["foo"],
				matches: [{}],
			},
		]);
		const { reply, calls } = makeReply();
		await handler({ query: "foo" }, reply);

		expect(calls[0].error).toBeUndefined();
		const text = textOf(calls[0]);
		expect(text).toContain('Omnisearch results for "foo"');
		expect(text).toContain("notes/foo.md");
		expect(text).toContain("123.5");
		expect(text).toContain("3 excerpts");
		expect(text).toContain("foo");
	});

	it("clamps max_results to the hard cap of 50", async () => {
		// Create 100 fake results so we can verify the cap fires.
		const fake = Array.from({ length: 100 }, (_, i) => ({
			path: `notes/f${i}.md`,
			score: 100 - i,
			foundWords: ["x"],
			matches: [{}],
		}));
		const { handler } = withOmnisearch(async () => fake);

		const { reply, calls } = makeReply();
		await handler({ query: "x", max_results: 9999 }, reply);

		const text = textOf(calls[0]);
		// header + at most 50 result lines = 51 lines
		expect(text.split("\n").length).toBeLessThanOrEqual(51);
		expect(text).toContain("showing top 50 of 100");
	});

	it("uses the default of 20 when max_results is missing", async () => {
		const fake = Array.from({ length: 30 }, (_, i) => ({
			path: `f${i}.md`,
			score: i,
			foundWords: ["x"],
			matches: [{}],
		}));
		const { handler } = withOmnisearch(async () => fake);

		const { reply, calls } = makeReply();
		await handler({ query: "x" }, reply);

		expect(textOf(calls[0])).toContain("showing top 20 of 30");
	});

	it("returns 'No matches' for an empty result array", async () => {
		const { handler } = withOmnisearch(async () => []);
		const { reply, calls } = makeReply();
		await handler({ query: "qqzz" }, reply);
		expect(textOf(calls[0])).toMatch(/no matches/i);
	});

	it("rejects missing query with -32602", async () => {
		const { handler } = withOmnisearch(async () => []);
		const { reply, calls } = makeReply();
		await handler({}, reply);
		expect(calls[0].error?.code).toBe(-32602);
	});

	it("converts plugin throws into -32603", async () => {
		const { handler } = withOmnisearch(async () => {
			throw new Error("index corrupted");
		});
		const { reply, calls } = makeReply();
		await handler({ query: "x" }, reply);
		expect(calls[0].error?.code).toBe(-32603);
		expect(calls[0].error?.message).toMatch(/index corrupted/);
	});
});

// ──────────────────────────────────────────────────────────────────────
// extract_text

describe("extract_text", () => {
	function withTextExtractor(api: any) {
		const { app, vault } = setup();
		app.plugins.__seedPlugin("text-extractor", api);
		const tools = new PluginTools(app as any);
		const handler = handlerByName(tools.createImplementations(), "extract_text");
		return { app, vault, tools, handler };
	}

	it("extracts text and prefixes with metadata header", async () => {
		const { vault, handler } = withTextExtractor({
			canFileBeExtracted: async () => true,
			extractText: async () => "page 1 content\npage 2 content",
		});
		// Need a real file in the vault for getAbstractFileByPath
		vault.__seed("docs/sample.pdf", "(binary, ignored by mock)");

		const { reply, calls } = makeReply();
		await handler({ path: "docs/sample.pdf" }, reply);

		expect(calls[0].error).toBeUndefined();
		const text = textOf(calls[0]);
		expect(text).toContain("Extracted");
		expect(text).toContain("docs/sample.pdf");
		expect(text).toContain("page 1 content");
		expect(text).toContain("page 2 content");
	});

	it("refuses markdown files (use `view` instead)", async () => {
		const { vault, handler } = withTextExtractor({
			canFileBeExtracted: async () => true,
			extractText: async () => "should not be called",
		});
		vault.__seed("note.md", "# Markdown");

		const { reply, calls } = makeReply();
		await handler({ path: "note.md" }, reply);

		expect(calls[0].error?.code).toBe(-32602);
		expect(calls[0].error?.message).toMatch(/markdown/i);
	});

	it("returns -32602 when Text Extractor cannot process the format", async () => {
		const { vault, handler } = withTextExtractor({
			canFileBeExtracted: async () => false,
			extractText: async () => "should not be called",
		});
		vault.__seed("data.bin", "binary");

		const { reply, calls } = makeReply();
		await handler({ path: "data.bin" }, reply);

		expect(calls[0].error?.code).toBe(-32602);
		expect(calls[0].error?.message).toMatch(/cannot process/i);
	});

	it("returns -32603 when the file doesn't exist", async () => {
		const { handler } = withTextExtractor({
			canFileBeExtracted: async () => true,
			extractText: async () => "x",
		});
		const { reply, calls } = makeReply();
		await handler({ path: "missing.pdf" }, reply);
		expect(calls[0].error?.code).toBe(-32603);
		expect(calls[0].error?.message).toMatch(/not found/i);
	});

	it("rejects directory traversal with -32602", async () => {
		const { handler } = withTextExtractor({
			canFileBeExtracted: async () => true,
			extractText: async () => "x",
		});
		const { reply, calls } = makeReply();
		await handler({ path: "../etc/passwd" }, reply);
		expect(calls[0].error?.code).toBe(-32602);
	});

	it("truncates extracted text past the response budget and labels it", async () => {
		// Construct text larger than the 256KB cap.
		const huge = "x".repeat(300_000);
		const { vault, handler } = withTextExtractor({
			canFileBeExtracted: async () => true,
			extractText: async () => huge,
		});
		vault.__seed("big.pdf", "");

		const { reply, calls } = makeReply();
		await handler({ path: "big.pdf" }, reply);

		const text = textOf(calls[0]);
		expect(text).toMatch(/TRUNCATED/);
		expect(text.length).toBeLessThan(huge.length + 1000);
	});
});

// ──────────────────────────────────────────────────────────────────────
// dataview_query

describe("dataview_query", () => {
	function withDataview(queryMarkdown: any) {
		const { app, vault } = setup();
		app.plugins.__seedPlugin("dataview", { queryMarkdown });
		const tools = new PluginTools(app as any);
		const handler = handlerByName(tools.createImplementations(), "dataview_query");
		return { app, vault, tools, handler };
	}

	it("returns the rendered markdown on a successful query", async () => {
		const { handler } = withDataview(async (q: string) => ({
			successful: true,
			value: "| File | date |\n| ---- | ---- |\n| a.md | 2026-01 |\n",
		}));
		const { reply, calls } = makeReply();
		await handler({ query: 'TABLE date FROM "events"' }, reply);

		expect(calls[0].error).toBeUndefined();
		const text = textOf(calls[0]);
		expect(text).toContain("| File | date |");
		expect(text).toContain("a.md");
	});

	it("returns isError:true (NOT a JSON-RPC error) on DQL parse failure", async () => {
		// Per MCP spec 2025-11-25 clarification (SEP-1303): input
		// validation errors should be Tool Execution Errors, not Protocol
		// Errors. Lets the model self-correct without a transport-level
		// rejection.
		const { handler } = withDataview(async () => ({
			successful: false,
			error: "PARSING FAILED at column 1: unexpected token",
		}));
		const { reply, calls } = makeReply();
		await handler({ query: "BOGUS" }, reply);

		expect(calls[0].error).toBeUndefined(); // NOT a JSON-RPC error
		expect(calls[0].result?.isError).toBe(true);
		expect(textOf(calls[0])).toMatch(/PARSING FAILED/);
	});

	it("rejects missing query with -32602", async () => {
		const { handler } = withDataview(async () => ({
			successful: true,
			value: "",
		}));
		const { reply, calls } = makeReply();
		await handler({}, reply);
		expect(calls[0].error?.code).toBe(-32602);
	});

	it("falls back gracefully when value is empty", async () => {
		const { handler } = withDataview(async () => ({
			successful: true,
			value: "",
		}));
		const { reply, calls } = makeReply();
		await handler({ query: "TABLE x FROM \"nothing\"" }, reply);
		expect(calls[0].error).toBeUndefined();
		// Empty string passes through; UI can render it as "empty result"
		expect(typeof textOf(calls[0])).toBe("string");
	});

	it("converts plugin throws into -32603", async () => {
		const { handler } = withDataview(async () => {
			throw new Error("dataview index not built yet");
		});
		const { reply, calls } = makeReply();
		await handler({ query: "LIST" }, reply);
		expect(calls[0].error?.code).toBe(-32603);
		expect(calls[0].error?.message).toMatch(/dataview index/);
	});
});
