import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../src/shared/tool-registry";
import type { McpRequest, McpResponse } from "../../src/mcp/types";

function makeReply() {
	const calls: Array<Omit<McpResponse, "jsonrpc" | "id">> = [];
	const reply = (msg: Omit<McpResponse, "jsonrpc" | "id">) => {
		calls.push(msg);
	};
	return { reply, calls };
}

function makeRequest(
	method: string,
	params?: any,
	id: string | number = 1
): McpRequest {
	return { jsonrpc: "2.0", id, method, params };
}

// ──────────────────────────────────────────────────────────────────────
// Annotation propagation across the wire
//
// The release notes claim "every tool carries safety annotations". Per-
// definition tests in general-tools.test.ts and metadata-tools.test.ts
// pin that for the source arrays, but the annotations also have to
// survive the trip through `getToolDefinitions()` which strips the
// internal `category` field. If the strip ever broadened to also drop
// annotations (via a stale spread), every client downstream would lose
// them silently. This test pins the contract end-to-end.

describe("ToolRegistry annotation propagation", () => {
	it("preserves `annotations` on getToolDefinitions() output", () => {
		const registry = new ToolRegistry();
		registry.register(
			{
				name: "demo",
				description: "x",
				category: "general",
				inputSchema: { type: "object", properties: {} },
				annotations: {
					title: "Demo Tool",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
			},
			{ name: "demo", handler: () => Promise.resolve() }
		);

		const [emitted] = registry.getToolDefinitions();
		// `category` should be stripped (it's an internal field)…
		expect((emitted as any).category).toBeUndefined();
		// …but `annotations` MUST survive.
		expect(emitted.annotations).toBeDefined();
		expect(emitted.annotations?.title).toBe("Demo Tool");
		expect(emitted.annotations?.readOnlyHint).toBe(true);
		expect(emitted.annotations?.openWorldHint).toBe(false);
	});

	it("getToolDefinitions() omits annotations when the source had none", () => {
		// Backward compat: legacy tools that haven't been annotated yet
		// shouldn't get an empty `annotations: {}` synthesized — the
		// field is optional in the wire format and clients distinguish
		// "absent" from "all-false".
		const registry = new ToolRegistry();
		registry.register(
			{
				name: "legacy",
				description: "x",
				category: "general",
				inputSchema: { type: "object", properties: {} },
			},
			{ name: "legacy", handler: () => Promise.resolve() }
		);

		const [emitted] = registry.getToolDefinitions();
		expect(emitted.annotations).toBeUndefined();
	});
});

describe("ToolRegistry", () => {
	describe("register", () => {
		it("registers a tool when names match", () => {
			const registry = new ToolRegistry();
			registry.register(
				{
					name: "demo",
					description: "demo tool",
					category: "general",
					inputSchema: { type: "object", properties: {} },
				},
				{
					name: "demo",
					handler: vi.fn(),
				}
			);

			expect(registry.hasImplementation("demo")).toBe(true);
			expect(registry.getRegisteredToolNames()).toContain("demo");
		});

		it("throws when definition and implementation names mismatch", () => {
			const registry = new ToolRegistry();
			expect(() =>
				registry.register(
					{
						name: "demo",
						description: "x",
						category: "general",
						inputSchema: { type: "object", properties: {} },
					},
					{ name: "other", handler: vi.fn() }
				)
			).toThrow(/doesn't match/);
		});
	});

	describe("getToolDefinitions", () => {
		it("strips internal category field from emitted definitions", () => {
			const registry = new ToolRegistry();
			registry.register(
				{
					name: "demo",
					description: "x",
					category: "general",
					inputSchema: { type: "object", properties: {} },
				},
				{ name: "demo", handler: vi.fn() }
			);

			const defs = registry.getToolDefinitions();
			expect(defs).toHaveLength(1);
			expect((defs[0] as any).category).toBeUndefined();
			expect(defs[0].name).toBe("demo");
		});

		it("filters by category when requested", () => {
			const registry = new ToolRegistry();
			registry.register(
				{
					name: "a",
					description: "x",
					category: "general",
					inputSchema: { type: "object", properties: {} },
				},
				{ name: "a", handler: vi.fn() }
			);
			registry.register(
				{
					name: "b",
					description: "x",
					category: "ide-specific",
					inputSchema: { type: "object", properties: {} },
				},
				{ name: "b", handler: vi.fn() }
			);

			expect(registry.getToolDefinitions("general")).toHaveLength(1);
			expect(registry.getToolDefinitions("ide-specific")).toHaveLength(1);
		});
	});

	describe("handleToolCall", () => {
		it("invokes the registered handler with the supplied args", async () => {
			const registry = new ToolRegistry();
			const handler = vi.fn(async (_args, reply) => {
				reply({ result: { content: [{ type: "text", text: "ok" }] } });
			});
			registry.register(
				{
					name: "demo",
					description: "x",
					category: "general",
					inputSchema: { type: "object", properties: {} },
				},
				{ name: "demo", handler }
			);

			const { reply, calls } = makeReply();
			await registry.handleToolCall(
				makeRequest("tools/call", { name: "demo", arguments: { a: 1 } }),
				reply
			);

			expect(handler).toHaveBeenCalledWith(
				{ a: 1 },
				expect.any(Function)
			);
			expect(calls[0].result).toBeDefined();
		});

		it("returns a JSON-RPC error for unknown tools", async () => {
			const registry = new ToolRegistry();
			const { reply, calls } = makeReply();

			await registry.handleToolCall(
				makeRequest("tools/call", { name: "missing", arguments: {} }),
				reply
			);

			expect(calls).toHaveLength(1);
			expect(calls[0].error).toBeDefined();
			expect(calls[0].error?.code).toBe(-32602);
			expect(calls[0].error?.message).toMatch(/unknown tool|not registered|not found/i);
			expect(calls[0].result).toBeUndefined();
		});

		it("converts handler exceptions into JSON-RPC errors", async () => {
			const registry = new ToolRegistry();
			registry.register(
				{
					name: "boom",
					description: "x",
					category: "general",
					inputSchema: { type: "object", properties: {} },
				},
				{
					name: "boom",
					handler: async () => {
						throw new Error("kaboom");
					},
				}
			);

			const { reply, calls } = makeReply();
			await registry.handleToolCall(
				makeRequest("tools/call", { name: "boom", arguments: {} }),
				reply
			);

			expect(calls[0].error).toBeDefined();
			expect(calls[0].error?.code).toBe(-32603);
			expect(calls[0].error?.message).toMatch(/kaboom/);
		});
	});
});
