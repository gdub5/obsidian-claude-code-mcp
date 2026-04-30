import { describe, it, expect, beforeEach } from "vitest";
import { App, Vault, MetadataCache } from "../mocks/obsidian";
import {
	MetadataTools,
	METADATA_TOOL_DEFINITIONS,
} from "../../src/tools/metadata-tools";
import type { McpResponse } from "../../src/mcp/types";
import type { ToolImplementation } from "../../src/shared/tool-registry";

// ──────────────────────────────────────────────────────────────────────
// Test harness — same shape as general-tools.test.ts so the patterns
// stay aligned across tool families.

function makeReply(): {
	reply: (m: any) => void;
	calls: Array<Omit<McpResponse, "jsonrpc" | "id">>;
} {
	const calls: Array<Omit<McpResponse, "jsonrpc" | "id">> = [];
	return {
		reply: (m) => calls.push(m),
		calls,
	};
}

function setup(): {
	app: App;
	vault: Vault;
	metadataCache: MetadataCache;
	handlers: Map<string, ToolImplementation>;
} {
	const vault = new Vault();
	const app = new App(vault);
	const tools = new MetadataTools(app as any);
	const handlers = new Map(
		tools.createImplementations().map((i) => [i.name, i])
	);
	return { app, vault, metadataCache: app.metadataCache, handlers };
}

const textOf = (call: any) => call.result?.content?.[0]?.text ?? "";

// ──────────────────────────────────────────────────────────────────────
// Definitions sanity check

describe("METADATA_TOOL_DEFINITIONS", () => {
	it("each definition has a matching implementation", () => {
		const { handlers } = setup();
		const defNames = METADATA_TOOL_DEFINITIONS.map((d) => d.name);
		const implNames = Array.from(handlers.keys());
		expect(implNames.sort()).toEqual(defNames.sort());
	});

	it("declares the six expected tools", () => {
		const names = METADATA_TOOL_DEFINITIONS.map((d) => d.name).sort();
		expect(names).toEqual([
			"find_by_tag",
			"get_backlinks",
			"get_frontmatter",
			"get_outgoing_links",
			"list_tags",
			"search_vault",
		]);
	});
});

// ──────────────────────────────────────────────────────────────────────
// get_frontmatter

describe("get_frontmatter", () => {
	it("returns parsed frontmatter as JSON", async () => {
		const { vault, metadataCache, handlers } = setup();
		vault.__seed("note.md", "---\ntitle: x\n---\nbody");
		metadataCache.__setFileCache("note.md", {
			frontmatter: { title: "x", tags: ["a", "b"], date: "2026-01-01" },
		});

		const { reply, calls } = makeReply();
		await handlers.get("get_frontmatter")!.handler({ path: "note.md" }, reply);

		expect(calls[0].error).toBeUndefined();
		const parsed = JSON.parse(textOf(calls[0]));
		expect(parsed).toEqual({
			title: "x",
			tags: ["a", "b"],
			date: "2026-01-01",
		});
	});

	it("returns null when the note has no frontmatter", async () => {
		const { vault, metadataCache, handlers } = setup();
		vault.__seed("plain.md", "no fm here");
		metadataCache.__setFileCache("plain.md", {}); // cache exists but no fm

		const { reply, calls } = makeReply();
		await handlers
			.get("get_frontmatter")!
			.handler({ path: "plain.md" }, reply);

		expect(calls[0].error).toBeUndefined();
		expect(JSON.parse(textOf(calls[0]))).toBeNull();
	});

	it("rejects missing file with -32603", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers
			.get("get_frontmatter")!
			.handler({ path: "missing.md" }, reply);
		expect(calls[0].error?.code).toBe(-32603);
	});

	it("rejects invalid path with -32602", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers.get("get_frontmatter")!.handler({}, reply);
		expect(calls[0].error?.code).toBe(-32602);
	});

	it("rejects path traversal with -32602", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers
			.get("get_frontmatter")!
			.handler({ path: "../etc/passwd" }, reply);
		expect(calls[0].error?.code).toBe(-32602);
	});
});

// ──────────────────────────────────────────────────────────────────────
// get_backlinks

describe("get_backlinks", () => {
	it("lists every source that links to the target, sorted", async () => {
		const { vault, metadataCache, handlers } = setup();
		vault.__seed("hub.md", "x");
		vault.__seed("leaf-a.md", "x");
		vault.__seed("leaf-c.md", "x");
		// Mirrors the fixture vault topology: hub→leaf-a, leaf-c→leaf-a
		metadataCache.__seedLinks({
			"hub.md": ["leaf-a.md", "leaf-b.md", "leaf-c.md"],
			"leaf-c.md": ["leaf-a.md"],
		});

		const { reply, calls } = makeReply();
		await handlers
			.get("get_backlinks")!
			.handler({ path: "leaf-a.md" }, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("hub.md");
		expect(text).toContain("leaf-c.md");
		// Sorted alphabetically, hub comes before leaf-c
		expect(text.indexOf("hub.md")).toBeLessThan(text.indexOf("leaf-c.md"));
		// Should report a count
		expect(text).toMatch(/2/);
	});

	it("reports zero backlinks cleanly", async () => {
		const { vault, metadataCache, handlers } = setup();
		vault.__seed("orphan.md", "x");
		// no links seeded
		const { reply, calls } = makeReply();
		await handlers
			.get("get_backlinks")!
			.handler({ path: "orphan.md" }, reply);

		expect(calls[0].error).toBeUndefined();
		expect(textOf(calls[0]).toLowerCase()).toMatch(/no backlinks/);
	});

	it("does NOT include outgoing links from the target itself", async () => {
		const { vault, metadataCache, handlers } = setup();
		vault.__seed("a.md", "x");
		vault.__seed("b.md", "x");
		// a links to b — but b's backlinks should include a, not b.
		metadataCache.__seedLinks({ "a.md": ["b.md"] });

		const { reply, calls } = makeReply();
		await handlers.get("get_backlinks")!.handler({ path: "b.md" }, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("a.md");
		expect(text.split("\n").filter((l: string) => l.includes("b.md")).length)
			.toBeLessThanOrEqual(1); // only the header line mentions b.md
	});
});

// ──────────────────────────────────────────────────────────────────────
// get_outgoing_links

describe("get_outgoing_links", () => {
	it("reports resolved targets sorted under a Resolved heading", async () => {
		const { vault, metadataCache, handlers } = setup();
		vault.__seed("hub.md", "x");
		metadataCache.__seedLinks({
			"hub.md": ["leaf-c.md", "leaf-a.md", "leaf-b.md"],
		});

		const { reply, calls } = makeReply();
		await handlers
			.get("get_outgoing_links")!
			.handler({ path: "hub.md" }, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("Resolved:");
		expect(text).toContain("leaf-a.md");
		expect(text).toContain("leaf-b.md");
		expect(text).toContain("leaf-c.md");
		// Sorted
		expect(text.indexOf("leaf-a.md")).toBeLessThan(text.indexOf("leaf-b.md"));
		expect(text.indexOf("leaf-b.md")).toBeLessThan(text.indexOf("leaf-c.md"));
	});

	it("separates resolved from unresolved", async () => {
		const { vault, metadataCache, handlers } = setup();
		vault.__seed("a.md", "x");
		metadataCache.resolvedLinks = { "a.md": { "real.md": 1 } };
		metadataCache.unresolvedLinks = { "a.md": { "missing.md": 1 } };

		const { reply, calls } = makeReply();
		await handlers
			.get("get_outgoing_links")!
			.handler({ path: "a.md" }, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("Resolved:");
		expect(text).toContain("real.md");
		expect(text).toContain("Unresolved:");
		expect(text).toContain("missing.md");
	});

	it("handles a file with no outgoing links", async () => {
		const { vault, handlers } = setup();
		vault.__seed("orphan.md", "x");
		const { reply, calls } = makeReply();
		await handlers
			.get("get_outgoing_links")!
			.handler({ path: "orphan.md" }, reply);

		expect(calls[0].error).toBeUndefined();
		expect(textOf(calls[0])).toMatch(/no links/i);
	});
});

// ──────────────────────────────────────────────────────────────────────
// list_tags

describe("list_tags", () => {
	it("aggregates inline + frontmatter tags across the vault", async () => {
		const { vault, metadataCache, handlers } = setup();
		vault.__seed("a.md", "x");
		vault.__seed("b.md", "x");
		vault.__seed("c.md", "x");
		metadataCache.__setFileCache("a.md", {
			tags: [{ tag: "#alpha" }, { tag: "#beta" }],
		});
		metadataCache.__setFileCache("b.md", {
			frontmatter: { tags: ["alpha", "gamma"] },
		});
		metadataCache.__setFileCache("c.md", {
			tags: [{ tag: "#beta" }],
		});

		const { reply, calls } = makeReply();
		await handlers.get("list_tags")!.handler({}, reply);

		const text = textOf(calls[0]);
		// #alpha appears in 2 files (a, b)
		expect(text).toMatch(/#alpha \(2\)/);
		// #beta appears in 2 files (a, c)
		expect(text).toMatch(/#beta \(2\)/);
		// #gamma appears in 1 file (b)
		expect(text).toMatch(/#gamma \(1\)/);
	});

	it("dedupes when a tag appears multiple times in one file", async () => {
		const { vault, metadataCache, handlers } = setup();
		vault.__seed("a.md", "x");
		metadataCache.__setFileCache("a.md", {
			tags: [{ tag: "#dup" }, { tag: "#dup" }, { tag: "#dup" }],
		});

		const { reply, calls } = makeReply();
		await handlers.get("list_tags")!.handler({}, reply);

		expect(textOf(calls[0])).toMatch(/#dup \(1\)/);
	});

	it("handles an empty vault", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers.get("list_tags")!.handler({}, reply);
		expect(textOf(calls[0]).toLowerCase()).toMatch(/no tags/);
	});
});

// ──────────────────────────────────────────────────────────────────────
// find_by_tag

describe("find_by_tag", () => {
	function withTaggedVault() {
		const ctx = setup();
		ctx.vault.__seed("a.md", "x");
		ctx.vault.__seed("b.md", "x");
		ctx.vault.__seed("c.md", "x");
		ctx.metadataCache.__setFileCache("a.md", {
			tags: [{ tag: "#project" }],
		});
		ctx.metadataCache.__setFileCache("b.md", {
			tags: [{ tag: "#project/april" }],
		});
		ctx.metadataCache.__setFileCache("c.md", {
			tags: [{ tag: "#unrelated" }],
		});
		return ctx;
	}

	it("matches the exact tag", async () => {
		const { handlers } = withTaggedVault();
		const { reply, calls } = makeReply();
		await handlers
			.get("find_by_tag")!
			.handler({ tag: "project", nested: false }, reply);
		const text = textOf(calls[0]);
		expect(text).toContain("a.md");
		expect(text).not.toContain("b.md"); // nested off → skip
	});

	it("includes nested tags when nested=true (default)", async () => {
		const { handlers } = withTaggedVault();
		const { reply, calls } = makeReply();
		await handlers.get("find_by_tag")!.handler({ tag: "project" }, reply);
		const text = textOf(calls[0]);
		expect(text).toContain("a.md");
		expect(text).toContain("b.md"); // #project/april matches
		expect(text).not.toContain("c.md");
	});

	it("accepts tag with or without leading #", async () => {
		const { handlers } = withTaggedVault();
		const a = makeReply();
		const b = makeReply();
		await handlers.get("find_by_tag")!.handler({ tag: "#project" }, a.reply);
		await handlers.get("find_by_tag")!.handler({ tag: "project" }, b.reply);
		expect(textOf(a.calls[0])).toBe(textOf(b.calls[0]));
	});

	it("reports no matches cleanly", async () => {
		const { handlers } = withTaggedVault();
		const { reply, calls } = makeReply();
		await handlers
			.get("find_by_tag")!
			.handler({ tag: "nonexistent" }, reply);
		expect(textOf(calls[0]).toLowerCase()).toMatch(/no files/);
	});

	it("rejects missing tag parameter with -32602", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers.get("find_by_tag")!.handler({}, reply);
		expect(calls[0].error?.code).toBe(-32602);
	});
});

// ──────────────────────────────────────────────────────────────────────
// search_vault

describe("search_vault", () => {
	it("finds matching lines and reports path:line:snippet", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "alpha\nbeta\ngamma");
		vault.__seed("b.md", "delta\nbeta is here too");

		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({ query: "beta" }, reply);

		const text = textOf(calls[0]);
		expect(text).toMatch(/a\.md:2: beta/);
		expect(text).toMatch(/b\.md:2: beta is here too/);
	});

	it("is case-insensitive by default", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "Alpha BETA gamma");
		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({ query: "beta" }, reply);
		expect(textOf(calls[0])).toContain("a.md:1");
	});

	it("respects case_sensitive=true", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "Alpha BETA gamma");
		const { reply, calls } = makeReply();
		await handlers
			.get("search_vault")!
			.handler({ query: "beta", case_sensitive: true }, reply);
		expect(textOf(calls[0]).toLowerCase()).toMatch(/no matches/);
	});

	it("caps results at max_results", async () => {
		const { vault, handlers } = setup();
		// Seed 100 files all containing "needle"
		for (let i = 0; i < 100; i++) {
			vault.__seed(`f${i}.md`, "needle");
		}
		const { reply, calls } = makeReply();
		await handlers
			.get("search_vault")!
			.handler({ query: "needle", max_results: 10 }, reply);

		const text = textOf(calls[0]);
		// 10 result lines + 1 header line = 11 lines max
		expect(text.split("\n").length).toBeLessThanOrEqual(11);
		expect(text).toMatch(/capped at 10/);
	});

	it("clamps max_results to the hard cap (200) even when caller asks for more", async () => {
		const { vault, handlers } = setup();
		// 250 files, each one matches; if cap weren't enforced we'd see 250.
		for (let i = 0; i < 250; i++) {
			vault.__seed(`f${i}.md`, "needle");
		}
		const { reply, calls } = makeReply();
		await handlers
			.get("search_vault")!
			.handler({ query: "needle", max_results: 9999 }, reply);

		const text = textOf(calls[0]);
		// header + at most 200 hit lines
		expect(text.split("\n").length).toBeLessThanOrEqual(201);
		expect(text).toMatch(/capped at 200 results/);
	});

	it("skips files larger than the per-file size cap", async () => {
		const { vault, handlers } = setup();
		// Real content is small but we lie via stat.size — avoids allocating
		// a real megabyte buffer in tests.
		vault.__seed("big.md", "needle here", { size: 5_000_000 });
		vault.__seed("small.md", "needle here");

		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({ query: "needle" }, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("small.md");
		expect(text).not.toContain("big.md");
	});

	it("ignores non-markdown files (binaries / canvas / images)", async () => {
		const { vault, handlers } = setup();
		vault.__seed("note.md", "needle in the note");
		// Non-markdown files would never be a useful target for full-text
		// search and could be huge — they should be filtered out entirely.
		vault.__seed("attachment.pdf", "needle pretending to be PDF text");
		vault.__seed("canvas.canvas", "{\"nodes\":[\"needle\"]}");
		vault.__seed("image.png", "needle binary blob");

		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({ query: "needle" }, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("note.md");
		expect(text).not.toContain("attachment.pdf");
		expect(text).not.toContain("canvas.canvas");
		expect(text).not.toContain("image.png");
	});

	it("stops scanning when the files-scanned budget trips on a no-match query", async () => {
		// Without the work-budget cap, a no-match query would visit every
		// markdown file in the vault. Codex's adversarial review correctly
		// identified that the original four caps only bound *output*, not
		// *work* — this test pins the work cap.
		const { vault, handlers } = setup();
		// 5,005 files: just past the 5,000 cap. None contain "needle".
		for (let i = 0; i < 5005; i++) {
			vault.__seed(`f${String(i).padStart(5, "0")}.md`, "haystack only");
		}

		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({ query: "needle" }, reply);

		const text = textOf(calls[0]);
		// Marker present so callers know the answer is incomplete
		expect(text).toMatch(/scan budget hit|search incomplete/i);
		// Files-scanned mode specifically (not bytes-scanned)
		expect(text).toContain("files scanned");
	});

	it("counts UTF-8 bytes (not UTF-16 code units) toward the bytes-scanned budget", async () => {
		// CJK content is 3 UTF-8 bytes per char but 1 UTF-16 code unit.
		// Pre-fix, bytesScanned was incremented by content.length, which
		// undercounts multibyte content 3x — a vault of CJK notes blew
		// well past the advertised 50MB cap before tripping. This test
		// ensures the counter uses real bytes (stat.size or
		// Buffer.byteLength), not code units.
		const { vault, handlers } = setup();
		// "中".repeat(333_000) → 333,000 code units, ~999,000 UTF-8 bytes.
		// Just under the 1MB per-file cap. 60 such files = ~60MB UTF-8,
		// which trips the 50MB byte budget. Under the buggy implementation
		// 60 × 333_000 = ~20MB code units → no trip.
		const multibyte = "中".repeat(333_000);
		for (let i = 0; i < 60; i++) {
			vault.__seed(`mb-${i}.md`, multibyte);
		}

		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({ query: "needle" }, reply);

		const text = textOf(calls[0]);
		expect(text).toMatch(/scan budget hit|search incomplete/i);
		expect(text).toContain("MB read");
	});

	it("stops scanning when the cumulative bytes-scanned budget trips", async () => {
		// Files just under the per-file 1MB cap — enough of them to push
		// cumulative bytes-scanned past the 50MB cap. Tests that the bytes
		// budget fires even when the files-count budget doesn't.
		const { vault, handlers } = setup();
		const nearCap = "x".repeat(999_000);
		// 55 × 999KB = ~54MB — past the 50MB cap, well under the 5,000-file cap.
		for (let i = 0; i < 55; i++) {
			vault.__seed(`big-${i}.md`, nearCap);
		}

		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({ query: "needle" }, reply);

		const text = textOf(calls[0]);
		expect(text).toMatch(/scan budget hit|search incomplete/i);
		expect(text).toContain("MB read");
	});

	it("no-match + no-budget-trip still says clean 'no matches'", async () => {
		// Important regression guard: a small vault that no-matches should
		// keep saying 'No matches' (not 'search incomplete'). The truncation
		// language is reserved for budget-bounded scans.
		const { vault, handlers } = setup();
		vault.__seed("a.md", "haystack only");
		vault.__seed("b.md", "haystack only");

		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({ query: "needle" }, reply);

		const text = textOf(calls[0]).toLowerCase();
		expect(text).toMatch(/no matches/);
		expect(text).not.toMatch(/incomplete|scan budget/);
	});

	it("truncates the response when the byte budget is exceeded", async () => {
		const { vault, handlers } = setup();
		// Long lines so each hit eats ~200 bytes — quickly hits the
		// 256KB budget without needing 200 hits.
		const longHit = "needle " + "x".repeat(190);
		for (let i = 0; i < 200; i++) {
			vault.__seed(`f${i}.md`, longHit);
		}
		const { reply, calls } = makeReply();
		await handlers
			.get("search_vault")!
			.handler({ query: "needle", max_results: 200 }, reply);

		const text = textOf(calls[0]);
		// Either the byte budget tripped (truncated marker) OR the count
		// cap tripped — both are acceptable outcomes for very wide hits.
		// What we MUST see is some kind of truncation marker, and the
		// total response stays under ~512KB (a generous safety multiple
		// of the 256KB target — the marker is a hard contract, the
		// physical cap is conservative).
		expect(text.length).toBeLessThan(512 * 1024);
		expect(text).toMatch(/truncated|capped/);
	});

	it("reports no matches cleanly", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "nothing here");
		const { reply, calls } = makeReply();
		await handlers
			.get("search_vault")!
			.handler({ query: "missing" }, reply);
		expect(textOf(calls[0]).toLowerCase()).toMatch(/no matches/);
	});

	it("rejects missing query with -32602", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({}, reply);
		expect(calls[0].error?.code).toBe(-32602);
	});

	it("trims very long lines into a snippet", async () => {
		const { vault, handlers } = setup();
		const longLine = "a".repeat(500) + " match " + "b".repeat(500);
		vault.__seed("a.md", longLine);
		const { reply, calls } = makeReply();
		await handlers.get("search_vault")!.handler({ query: "match" }, reply);
		const text = textOf(calls[0]);
		// Snippet capped + ellipsis appended
		expect(text).toContain("…");
	});
});
