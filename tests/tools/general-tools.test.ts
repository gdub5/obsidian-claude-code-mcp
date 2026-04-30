import { describe, it, expect, beforeEach } from "vitest";
import { App, Vault, Workspace, TFile } from "../mocks/obsidian";
import {
	GeneralTools,
	GENERAL_TOOL_DEFINITIONS,
} from "../../src/tools/general-tools";
import type { McpResponse } from "../../src/mcp/types";
import type { ToolImplementation } from "../../src/shared/tool-registry";

// ──────────────────────────────────────────────────────────────────────
// Test harness
//
// `GeneralTools.createImplementations()` returns the full list of handlers
// keyed by name. The tests call those handlers directly with a captured
// reply function and assert on the response shape.

interface Reply {
	calls: Array<Omit<McpResponse, "jsonrpc" | "id">>;
}

function makeReply(): { reply: (m: any) => void; calls: Reply["calls"] } {
	const calls: Reply["calls"] = [];
	return {
		reply: (m) => calls.push(m),
		calls,
	};
}

function setup(): {
	app: App;
	vault: Vault;
	workspace: Workspace;
	handlers: Map<string, ToolImplementation>;
} {
	const vault = new Vault();
	const app = new App(vault);
	const tools = new GeneralTools(app as any);
	const impls = tools.createImplementations();
	const handlers = new Map(impls.map((i) => [i.name, i]));
	return { app, vault, workspace: app.workspace, handlers };
}

function textOf(call: Reply["calls"][number]): string {
	return call.result?.content?.[0]?.text ?? "";
}

// ──────────────────────────────────────────────────────────────────────
// Tool definitions sanity check

describe("GENERAL_TOOL_DEFINITIONS", () => {
	it("each definition has a matching implementation", () => {
		const { handlers } = setup();
		const defNames = GENERAL_TOOL_DEFINITIONS.map((d) => d.name);
		const implNames = Array.from(handlers.keys());
		expect(implNames.sort()).toEqual(defNames.sort());
	});

	it("every input schema is a valid JSON-Schema object", () => {
		for (const def of GENERAL_TOOL_DEFINITIONS) {
			expect(def.inputSchema.type).toBe("object");
			expect(def.inputSchema.properties).toBeDefined();
		}
	});
});

// ──────────────────────────────────────────────────────────────────────
// view

describe("view", () => {
	it("reads a file with line numbers", async () => {
		const { vault, handlers } = setup();
		vault.__seed("notes/foo.md", "alpha\nbeta\ngamma\n");

		const { reply, calls } = makeReply();
		await handlers.get("view")!.handler({ path: "notes/foo.md" }, reply);

		expect(calls[0].error).toBeUndefined();
		const text = textOf(calls[0]);
		expect(text).toContain("1: alpha");
		expect(text).toContain("2: beta");
		expect(text).toContain("3: gamma");
	});

	it("supports view_range to slice line numbers", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "L1\nL2\nL3\nL4\nL5\n");

		const { reply, calls } = makeReply();
		await handlers
			.get("view")!
			.handler({ path: "a.md", view_range: [2, 4] }, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("2: L2");
		expect(text).toContain("3: L3");
		expect(text).toContain("4: L4");
		expect(text).not.toContain("1: L1");
		expect(text).not.toContain("5: L5");
	});

	it("treats view_range[1] === -1 as 'to end of file'", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "L1\nL2\nL3\n");

		const { reply, calls } = makeReply();
		await handlers
			.get("view")!
			.handler({ path: "a.md", view_range: [2, -1] }, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("2: L2");
		expect(text).toContain("3: L3");
		expect(text).not.toContain("1: L1");
	});

	it("rejects missing path with -32602", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers.get("view")!.handler({}, reply);
		expect(calls[0].error?.code).toBe(-32602);
	});

	it("rejects directory traversal with -32602 (param validation)", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers.get("view")!.handler({ path: "../etc/passwd" }, reply);
		// This is a parameter validation failure, not an internal error,
		// so the JSON-RPC code should be -32602, not -32603.
		expect(calls[0].error?.code).toBe(-32602);
	});

	it("returns an error when the file does not exist", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers.get("view")!.handler({ path: "missing.md" }, reply);
		expect(calls[0].error).toBeDefined();
	});

	describe("on a directory", () => {
		it("lists direct files", async () => {
			const { vault, handlers } = setup();
			vault.__seed("notes/a.md", "x");
			vault.__seed("notes/b.md", "y");

			const { reply, calls } = makeReply();
			await handlers.get("view")!.handler({ path: "notes" }, reply);

			const text = textOf(calls[0]);
			expect(text).toContain("notes/a.md");
			expect(text).toContain("notes/b.md");
		});

		it("surfaces direct subfolder names alongside files", async () => {
			// This is the "view of a directory misses subfolders" bug.
			// Layout:
			//   notes/index.md       ← direct file
			//   notes/sub/deep.md    ← in subfolder
			const { vault, handlers } = setup();
			vault.__seed("notes/index.md", "x");
			vault.__seed("notes/sub/deep.md", "y");

			const { reply, calls } = makeReply();
			await handlers.get("view")!.handler({ path: "notes" }, reply);

			const text = textOf(calls[0]);
			expect(text).toContain("notes/index.md");
			// Subfolder must appear in the listing — user otherwise has no way
			// to discover that `notes/sub/` exists.
			expect(text).toMatch(/notes\/sub\/?/);
		});

		it("does not duplicate a subfolder when it contains multiple files", async () => {
			const { vault, handlers } = setup();
			vault.__seed("notes/sub/a.md", "x");
			vault.__seed("notes/sub/b.md", "y");
			vault.__seed("notes/sub/c.md", "z");

			const { reply, calls } = makeReply();
			await handlers.get("view")!.handler({ path: "notes" }, reply);

			const text = textOf(calls[0]);
			const subOccurrences = (text.match(/notes\/sub\/?/g) || []).length;
			expect(subOccurrences).toBe(1);
		});
	});
});

// ──────────────────────────────────────────────────────────────────────
// create

describe("create", () => {
	it("writes a new file at a top-level path", async () => {
		const { vault, handlers } = setup();
		const { reply, calls } = makeReply();

		await handlers
			.get("create")!
			.handler({ path: "new.md", file_text: "hello" }, reply);

		expect(calls[0].error).toBeUndefined();
		expect(vault.__hasFile("new.md")).toBe(true);
	});

	it("auto-creates parent folders when they don't exist (the bug)", async () => {
		// Without the fix, vault.adapter.write throws ENOENT because
		// `notes/sub/` doesn't exist as a folder yet.
		const { vault, handlers } = setup();
		const { reply, calls } = makeReply();

		await handlers
			.get("create")!
			.handler(
				{ path: "notes/sub/new.md", file_text: "hello" },
				reply
			);

		expect(calls[0].error).toBeUndefined();
		expect(vault.__hasFile("notes/sub/new.md")).toBe(true);
		expect(vault.__hasFolder("notes/sub")).toBe(true);
		expect(vault.__hasFolder("notes")).toBe(true);
	});

	it("auto-creates deeply nested parents", async () => {
		const { vault, handlers } = setup();
		const { reply, calls } = makeReply();

		await handlers
			.get("create")!
			.handler(
				{ path: "a/b/c/d/file.md", file_text: "x" },
				reply
			);

		expect(calls[0].error).toBeUndefined();
		expect(vault.__hasFolder("a/b/c/d")).toBe(true);
	});

	it("succeeds when parent folder already exists", async () => {
		const { vault, handlers } = setup();
		await vault.createFolder("existing");
		const { reply, calls } = makeReply();

		await handlers
			.get("create")!
			.handler(
				{ path: "existing/new.md", file_text: "x" },
				reply
			);

		expect(calls[0].error).toBeUndefined();
	});

	it("refuses to overwrite an existing file", async () => {
		const { vault, handlers } = setup();
		vault.__seed("foo.md", "original");
		const { reply, calls } = makeReply();

		await handlers
			.get("create")!
			.handler({ path: "foo.md", file_text: "new" }, reply);

		expect(calls[0].error).toBeDefined();
		expect(calls[0].error?.message).toMatch(/exist/i);
		// Original content untouched
		expect(vault.__hasFile("foo.md")).toBe(true);
	});

	it("rejects directory traversal with -32602", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers
			.get("create")!
			.handler({ path: "../escape.md", file_text: "x" }, reply);
		expect(calls[0].error?.code).toBe(-32602);
	});

	it("rejects missing parameters with -32602", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers.get("create")!.handler({ path: "x.md" }, reply); // no file_text
		expect(calls[0].error?.code).toBe(-32602);
	});
});

// ──────────────────────────────────────────────────────────────────────
// str_replace

describe("str_replace", () => {
	it("replaces an exact unique match", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "foo bar baz");
		const { reply, calls } = makeReply();

		await handlers
			.get("str_replace")!
			.handler(
				{ path: "a.md", old_str: "bar", new_str: "BAR" },
				reply
			);

		expect(calls[0].error).toBeUndefined();
		const adapter = vault.adapter;
		expect(await adapter.read("a.md")).toBe("foo BAR baz");
	});

	it("errors when old_str does not appear", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "hello world");
		const { reply, calls } = makeReply();

		await handlers
			.get("str_replace")!
			.handler(
				{ path: "a.md", old_str: "missing", new_str: "x" },
				reply
			);

		expect(calls[0].error).toBeDefined();
		expect(calls[0].error?.message).toMatch(/no match/i);
	});

	it("errors when old_str matches multiple locations", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "foo foo foo");
		const { reply, calls } = makeReply();

		await handlers
			.get("str_replace")!
			.handler(
				{ path: "a.md", old_str: "foo", new_str: "bar" },
				reply
			);

		expect(calls[0].error).toBeDefined();
		expect(calls[0].error?.message).toMatch(/3 matches/i);
	});

	it("rejects missing parameters with -32602", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers
			.get("str_replace")!
			.handler({ path: "a.md", old_str: "x" }, reply); // no new_str
		expect(calls[0].error?.code).toBe(-32602);
	});
});

// ──────────────────────────────────────────────────────────────────────
// insert

describe("insert", () => {
	it("inserts text at a 1-indexed line", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "L1\nL2\nL3");
		const { reply, calls } = makeReply();

		await handlers
			.get("insert")!
			.handler(
				{ path: "a.md", insert_line: 1, new_str: "INSERTED" },
				reply
			);

		expect(calls[0].error).toBeUndefined();
		expect(await vault.adapter.read("a.md")).toBe("L1\nINSERTED\nL2\nL3");
	});

	it("insert_line 0 prepends to the file", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "L1\nL2");
		const { reply, calls } = makeReply();

		await handlers
			.get("insert")!
			.handler(
				{ path: "a.md", insert_line: 0, new_str: "TOP" },
				reply
			);

		expect(calls[0].error).toBeUndefined();
		expect(await vault.adapter.read("a.md")).toBe("TOP\nL1\nL2");
	});

	it("rejects out-of-range insert_line", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "L1\nL2"); // 2 lines
		const { reply, calls } = makeReply();

		await handlers
			.get("insert")!
			.handler({ path: "a.md", insert_line: 99, new_str: "x" }, reply);

		expect(calls[0].error).toBeDefined();
		expect(calls[0].error?.message).toMatch(/Invalid insert_line/);
	});

	it("rejects negative insert_line", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "L1");
		const { reply, calls } = makeReply();

		await handlers
			.get("insert")!
			.handler({ path: "a.md", insert_line: -1, new_str: "x" }, reply);

		expect(calls[0].error).toBeDefined();
	});
});

// ──────────────────────────────────────────────────────────────────────
// get_current_file

describe("get_current_file", () => {
	it("reports the active file when one exists", async () => {
		const { app, handlers } = setup();
		app.workspace.__setActiveFile(new TFile("active.md") as any);
		const { reply, calls } = makeReply();

		await handlers.get("get_current_file")!.handler({}, reply);
		expect(textOf(calls[0])).toContain("active.md");
	});

	it("reports 'no active file' when none is open", async () => {
		const { handlers } = setup();
		const { reply, calls } = makeReply();
		await handlers.get("get_current_file")!.handler({}, reply);
		expect(textOf(calls[0]).toLowerCase()).toMatch(/no file/);
	});
});

// ──────────────────────────────────────────────────────────────────────
// get_workspace_files

describe("get_workspace_files", () => {
	it("returns the full list when no pattern given", async () => {
		const { vault, handlers } = setup();
		vault.__seed("a.md", "x");
		vault.__seed("notes/b.md", "y");
		vault.__seed("notes/c.md", "z");

		const { reply, calls } = makeReply();
		await handlers.get("get_workspace_files")!.handler({}, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("a.md");
		expect(text).toContain("notes/b.md");
		expect(text).toContain("notes/c.md");
	});

	it("filters by regex pattern", async () => {
		const { vault, handlers } = setup();
		vault.__seed("alpha.md", "");
		vault.__seed("beta.md", "");
		vault.__seed("gamma.txt", "");

		const { reply, calls } = makeReply();
		await handlers
			.get("get_workspace_files")!
			.handler({ pattern: "\\.md$" }, reply);

		const text = textOf(calls[0]);
		expect(text).toContain("alpha.md");
		expect(text).toContain("beta.md");
		expect(text).not.toContain("gamma.txt");
	});
});
