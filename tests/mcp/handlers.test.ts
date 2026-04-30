import { describe, it, expect, beforeEach, vi } from "vitest";
import { App } from "../mocks/obsidian";
import { McpHandlers } from "../../src/mcp/handlers";
import { ToolRegistry } from "../../src/shared/tool-registry";
import type { McpRequest, McpResponse } from "../../src/mcp/types";

function makeReply() {
	const calls: Array<Omit<McpResponse, "jsonrpc" | "id">> = [];
	const reply = (msg: Omit<McpResponse, "jsonrpc" | "id">) => {
		calls.push(msg);
	};
	return { reply, calls };
}

function req(method: string, params?: any, id: string | number = 1): McpRequest {
	const out: any = { jsonrpc: "2.0", method, id };
	if (params !== undefined) out.params = params;
	return out as McpRequest;
}

function notif(method: string, params?: any): McpRequest {
	const out: any = { jsonrpc: "2.0", method };
	if (params !== undefined) out.params = params;
	return out as McpRequest;
}

function makeHandlers() {
	const app = new App();
	const wsRegistry = new ToolRegistry();
	const httpRegistry = new ToolRegistry();
	const handlers = new McpHandlers(app as any, wsRegistry, httpRegistry);
	return { handlers, app, wsRegistry, httpRegistry };
}

describe("McpHandlers", () => {
	describe("initialize", () => {
		it("returns the 2024-11-05 protocol version", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(req("initialize", {}), reply);

			expect(calls).toHaveLength(1);
			expect(calls[0].result?.protocolVersion).toBe("2024-11-05");
		});

		it("declares only capabilities that are actually implemented", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(req("initialize", {}), reply);

			const caps = calls[0].result?.capabilities;
			expect(caps).toBeDefined();
			// `tools` IS implemented — must be advertised.
			expect(caps.tools).toBeDefined();
			// `roots` is a CLIENT capability — server must not advertise it.
			expect(caps.roots).toBeUndefined();
			// `prompts` and `resources` return empty lists today, so we
			// should not advertise them until they're real.
			expect(caps.prompts).toBeUndefined();
			expect(caps.resources).toBeUndefined();
		});

		it("reports a non-placeholder server version", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(req("initialize", {}), reply);

			const version = calls[0].result?.serverInfo?.version;
			expect(version).toBeDefined();
			expect(version).not.toBe("1.0.0");
			expect(version).toMatch(/^\d+\.\d+\.\d+/);
		});
	});

	describe("notifications", () => {
		it("does not reply to notifications/initialized", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(
				notif("notifications/initialized"),
				reply
			);

			expect(calls).toHaveLength(0);
		});

		it("does not reply to notifications/cancelled", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(
				notif("notifications/cancelled", { requestId: 1 }),
				reply
			);

			expect(calls).toHaveLength(0);
		});

		it("does not reply to unknown notifications", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(
				notif("notifications/whatever"),
				reply
			);

			expect(calls).toHaveLength(0);
		});
	});

	describe("ping", () => {
		it("responds to ping with an empty result", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(req("ping"), reply);

			expect(calls).toHaveLength(1);
			expect(calls[0].error).toBeUndefined();
		});
	});

	describe("unknown methods", () => {
		it("returns -32601 method-not-found for an unknown request", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(req("not/a/real/method"), reply);

			expect(calls).toHaveLength(1);
			expect(calls[0].error?.code).toBe(-32601);
		});
	});

	describe("legacy direct-method handlers", () => {
		it("rejects readFile (removed in cleanup)", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(
				req("readFile", { path: "x.md" }),
				reply
			);

			expect(calls[0].error?.code).toBe(-32601);
		});

		it("rejects writeFile (removed in cleanup)", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(
				req("writeFile", { path: "x.md", content: "y" }),
				reply
			);

			expect(calls[0].error?.code).toBe(-32601);
		});

		it("rejects getWorkspaceInfo (removed in cleanup)", async () => {
			const { handlers } = makeHandlers();
			const { reply, calls } = makeReply();

			await handlers.handleHttpRequest(req("getWorkspaceInfo"), reply);

			expect(calls[0].error?.code).toBe(-32601);
		});
	});
});
