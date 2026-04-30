import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import { McpHttpServer } from "../../src/mcp/http-server";

const TOKEN = "deadbeefcafebabe1234567890abcdefdeadbeefcafebabe1234567890abcdef";

interface FetchResult {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

function fetchOnce(
	method: string,
	path: string,
	port: number,
	headers: Record<string, string> = {},
	body?: string
): Promise<FetchResult> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				method,
				path,
				headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			}
		);
		req.on("error", reject);
		// Match the server's SSE keep-alive and the few-second test ceiling.
		req.setTimeout(2000, () => req.destroy(new Error("test timeout")));
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/**
 * For SSE: open the connection, read a single chunk to confirm the headers,
 * then drop the request. We don't want long-lived streams in tests.
 */
function openSseAndRead(
	port: number,
	headers: Record<string, string> = {},
	path = "/sse"
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				method: "GET",
				path,
				headers: { Accept: "text/event-stream", ...headers },
			},
			(res) => {
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
				});
				res.destroy();
			}
		);
		req.on("error", reject);
		req.setTimeout(2000, () => req.destroy(new Error("test timeout")));
		req.end();
	});
}

describe("McpHttpServer construction", () => {
	it("refuses to construct without an auth token", () => {
		expect(
			() =>
				new McpHttpServer({
					onMessage: () => {},
					authToken: "",
				})
		).toThrow(/authToken/);
	});
});

describe("McpHttpServer auth", () => {
	let server: McpHttpServer;
	let port: number;

	beforeEach(async () => {
		server = new McpHttpServer({
			onMessage: () => {},
			authToken: TOKEN,
		});
		// Port 0 lets the OS pick a free port — keeps tests independent.
		port = await server.start(0);
	});

	afterEach(() => {
		server.stop();
	});

	describe("Authorization header on /messages POST", () => {
		it("returns 401 when the header is missing", async () => {
			const res = await fetchOnce(
				"POST",
				"/messages?session_id=abc",
				port,
				{ "Content-Type": "application/json" },
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
			);
			expect(res.status).toBe(401);
			expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
		});

		it("returns 401 with the wrong token", async () => {
			const res = await fetchOnce(
				"POST",
				"/messages?session_id=abc",
				port,
				{
					"Content-Type": "application/json",
					Authorization: "Bearer wrong-token",
				},
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
			);
			expect(res.status).toBe(401);
		});

		it("returns 404 (session-not-found) with the correct token (auth passes)", async () => {
			// We haven't opened an SSE session, so the next layer rejects with
			// 404. The point of this test is that auth lets the request through.
			const res = await fetchOnce(
				"POST",
				"/messages?session_id=nonexistent",
				port,
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TOKEN}`,
				},
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
			);
			expect(res.status).toBe(404);
		});
	});

	describe("Authorization on /sse GET", () => {
		it("returns 401 with no token", async () => {
			const res = await openSseAndRead(port);
			expect(res.status).toBe(401);
		});

		it("returns 401 with wrong token in query", async () => {
			const res = await openSseAndRead(port, {}, "/sse?token=nope");
			expect(res.status).toBe(401);
		});

		it("opens SSE stream with valid Bearer header", async () => {
			const res = await openSseAndRead(port, {
				Authorization: `Bearer ${TOKEN}`,
			});
			expect(res.status).toBe(200);
			expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
		});

		it("opens SSE stream with valid ?token= query (EventSource fallback)", async () => {
			const res = await openSseAndRead(port, {}, `/sse?token=${TOKEN}`);
			expect(res.status).toBe(200);
			expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
		});
	});

	describe("Origin check", () => {
		it("rejects cross-origin browser requests with 403", async () => {
			const res = await fetchOnce("POST", "/messages?session_id=abc", port, {
				"Content-Type": "application/json",
				Authorization: `Bearer ${TOKEN}`,
				Origin: "https://evil.example.com",
			}, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
			expect(res.status).toBe(403);
		});

		it("accepts requests with localhost Origin", async () => {
			const res = await fetchOnce("POST", "/messages?session_id=nonexistent", port, {
				"Content-Type": "application/json",
				Authorization: `Bearer ${TOKEN}`,
				Origin: "http://localhost:5173",
			}, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
			expect(res.status).toBe(404); // session-not-found, not 403
		});

		it("accepts requests with no Origin (native MCP clients)", async () => {
			const res = await fetchOnce(
				"POST",
				"/messages?session_id=nonexistent",
				port,
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TOKEN}`,
				},
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
			);
			expect(res.status).toBe(404); // auth + origin both pass
		});
	});

	describe("CORS preflight", () => {
		it("responds 200 to OPTIONS without requiring auth", async () => {
			const res = await fetchOnce("OPTIONS", "/messages", port);
			expect(res.status).toBe(200);
		});
	});
});

// ──────────────────────────────────────────────────────────────────────
// Streamable HTTP transport (PR C — /mcp endpoint)
//
// Distinct describe block + setup so the tests stay isolated. The server
// here uses an onMessage stub that just echoes the method back as a
// successful result; it lets us exercise the transport layer without
// pulling the full MCP handler chain into the test.

describe("McpHttpServer Streamable HTTP (/mcp)", () => {
	let server: McpHttpServer;
	let port: number;

	beforeEach(async () => {
		server = new McpHttpServer({
			onMessage: (req, reply) => {
				// Echo the method back. For initialize, also echo a
				// protocolVersion so the server can capture it for the
				// post-init MCP-Protocol-Version header validation.
				if (req.method === "initialize") {
					reply({
						result: {
							protocolVersion: "2024-11-05",
							capabilities: { tools: {} },
							serverInfo: { name: "test", version: "0" },
						},
					});
				} else {
					reply({ result: { method: req.method, params: req.params } });
				}
			},
			authToken: TOKEN,
		});
		port = await server.start(0);
	});

	afterEach(() => {
		server.stop();
	});

	/**
	 * Helper. Auto-injects MCP-Protocol-Version on post-init requests
	 * (anything that's not `initialize`) so individual tests don't have
	 * to repeat it. Tests of header validation override via extraHeaders
	 * with a sentinel that this helper passes through unchanged.
	 */
	function postMcp(
		body: any,
		extraHeaders: Record<string, string> = {}
	): Promise<FetchResult> {
		const isInit = Array.isArray(body)
			? body.some((m) => m?.method === "initialize")
			: body?.method === "initialize";
		const baseHeaders: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/json",
		};
		if (!isInit && extraHeaders["Mcp-Session-Id"] !== undefined) {
			// Default to the supported version unless the caller is
			// explicitly testing header presence/absence.
			if (extraHeaders["MCP-Protocol-Version"] === undefined) {
				baseHeaders["MCP-Protocol-Version"] = "2024-11-05";
			}
		}
		return fetchOnce(
			"POST",
			"/mcp",
			port,
			{ ...baseHeaders, ...extraHeaders },
			JSON.stringify(body)
		);
	}

	describe("auth", () => {
		it("rejects POST /mcp without auth", async () => {
			const res = await fetchOnce(
				"POST",
				"/mcp",
				port,
				{ "Content-Type": "application/json" },
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
			);
			expect(res.status).toBe(401);
		});

		it("rejects POST /mcp with wrong token", async () => {
			const res = await fetchOnce(
				"POST",
				"/mcp",
				port,
				{
					"Content-Type": "application/json",
					Authorization: "Bearer nope",
				},
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
			);
			expect(res.status).toBe(401);
		});
	});

	describe("initialize", () => {
		it("mints a session and returns Mcp-Session-Id in response headers", async () => {
			const res = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			});
			expect(res.status).toBe(200);
			expect(res.headers["mcp-session-id"]).toMatch(/^[0-9a-f-]{36}$/);
			expect(res.headers["content-type"]).toMatch(/application\/json/);

			const payload = JSON.parse(res.body);
			expect(payload.id).toBe(1);
			expect(payload.jsonrpc).toBe("2.0");
			expect(payload.result).toBeDefined();
		});

		it("preserves a client-supplied session id if it matches an existing session", async () => {
			// First initialize to mint a session
			const first = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
			});
			const sid = first.headers["mcp-session-id"] as string;

			// Re-initialize with the same id — server should keep it
			const second = await postMcp(
				{ jsonrpc: "2.0", id: 2, method: "initialize" },
				{ "Mcp-Session-Id": sid }
			);
			expect(second.headers["mcp-session-id"]).toBe(sid);
		});
	});

	describe("session enforcement", () => {
		it("returns 400 when a non-initialize request omits Mcp-Session-Id", async () => {
			const res = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
			});
			expect(res.status).toBe(400);
			const err = JSON.parse(res.body);
			expect(err.error?.message).toMatch(/Mcp-Session-Id/i);
		});

		it("returns 404 when Mcp-Session-Id is unknown", async () => {
			const res = await postMcp(
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ "Mcp-Session-Id": "00000000-0000-0000-0000-000000000000" }
			);
			expect(res.status).toBe(404);
			const err = JSON.parse(res.body);
			expect(err.error?.message).toMatch(/unknown|expired/i);
		});

		it("accepts subsequent requests with the minted session id", async () => {
			const init = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
			});
			const sid = init.headers["mcp-session-id"] as string;

			const res = await postMcp(
				{ jsonrpc: "2.0", id: 2, method: "tools/list" },
				{ "Mcp-Session-Id": sid }
			);
			expect(res.status).toBe(200);
			expect(res.headers["mcp-session-id"]).toBe(sid);
			const payload = JSON.parse(res.body);
			expect(payload.id).toBe(2);
		});
	});

	describe("body shapes", () => {
		it("returns a single response object for a single-request body", async () => {
			const res = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
			});
			const payload = JSON.parse(res.body);
			expect(Array.isArray(payload)).toBe(false);
			expect(payload.id).toBe(1);
		});

		it("returns an array when given an array body", async () => {
			const init = await postMcp({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
			});
			const sid = init.headers["mcp-session-id"] as string;

			const res = await postMcp(
				[
					{ jsonrpc: "2.0", id: 1, method: "tools/list" },
					{ jsonrpc: "2.0", id: 2, method: "ping" },
				],
				{ "Mcp-Session-Id": sid }
			);
			expect(res.status).toBe(200);
			const payload = JSON.parse(res.body);
			expect(Array.isArray(payload)).toBe(true);
			expect(payload).toHaveLength(2);
			expect(payload.map((p: any) => p.id).sort()).toEqual([1, 2]);
		});

		it("returns 202 Accepted with no body for notification-only requests", async () => {
			const init = await postMcp({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
			});
			const sid = init.headers["mcp-session-id"] as string;

			const res = await postMcp(
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ "Mcp-Session-Id": sid }
			);
			expect(res.status).toBe(202);
			expect(res.body).toBe("");
		});

		it("returns -32700 Parse error for invalid JSON", async () => {
			const res = await fetchOnce(
				"POST",
				"/mcp",
				port,
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TOKEN}`,
				},
				"{ not json"
			);
			expect(res.status).toBe(400);
			const err = JSON.parse(res.body);
			expect(err.error?.code).toBe(-32700);
		});

		it("returns -32600 for an empty batch", async () => {
			const res = await postMcp([] as any);
			expect(res.status).toBe(400);
			const err = JSON.parse(res.body);
			expect(err.error?.code).toBe(-32600);
		});
	});

	describe("Accept header", () => {
		it("returns 406 when client only accepts text/event-stream (we don't stream)", async () => {
			const res = await fetchOnce(
				"POST",
				"/mcp",
				port,
				{
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					Authorization: `Bearer ${TOKEN}`,
				},
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
			);
			expect(res.status).toBe(406);
		});

		it("accepts an empty Accept header (treats as application/json)", async () => {
			const res = await fetchOnce(
				"POST",
				"/mcp",
				port,
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TOKEN}`,
				},
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
			);
			expect(res.status).toBe(200);
		});
	});

	describe("method routing", () => {
		it("returns 405 for GET /mcp (no server-initiated stream support)", async () => {
			const res = await fetchOnce("GET", "/mcp", port, {
				Authorization: `Bearer ${TOKEN}`,
			});
			expect(res.status).toBe(405);
			expect(res.headers["allow"]).toMatch(/POST/);
		});
	});

	describe("MCP-Protocol-Version validation (post-init)", () => {
		// All three tests follow the same pattern: initialize, then send
		// a follow-up with the version header in some shape.

		async function freshSession(): Promise<string> {
			const init = await postMcp({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: {},
			});
			return init.headers["mcp-session-id"] as string;
		}

		it("rejects post-init requests missing the version header", async () => {
			const sid = await freshSession();
			// Use raw fetchOnce to deliberately omit MCP-Protocol-Version
			// (postMcp would auto-inject it).
			const res = await fetchOnce(
				"POST",
				"/mcp",
				port,
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TOKEN}`,
					Accept: "application/json",
					"Mcp-Session-Id": sid,
				},
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
			);
			expect(res.status).toBe(400);
			const err = JSON.parse(res.body);
			expect(err.error?.message).toMatch(/MCP-Protocol-Version/i);
		});

		it("rejects requests with an unsupported version", async () => {
			const sid = await freshSession();
			const res = await postMcp(
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ "Mcp-Session-Id": sid, "MCP-Protocol-Version": "9999-99-99" }
			);
			expect(res.status).toBe(400);
			const err = JSON.parse(res.body);
			// The check is now per-session (mismatch with what THIS session
			// negotiated), not server-wide ("unsupported"). Either message
			// counts as a correct rejection.
			expect(err.error?.message).toMatch(/mismatch|Unsupported|negotiated/i);
		});

		it("accepts requests with the negotiated version", async () => {
			const sid = await freshSession();
			const res = await postMcp(
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ "Mcp-Session-Id": sid, "MCP-Protocol-Version": "2024-11-05" }
			);
			expect(res.status).toBe(200);
		});

		it("does not require the version header on initialize itself", async () => {
			// Pre-negotiation, the client doesn't yet know what version
			// the server speaks — requiring the header on initialize would
			// be a chicken-and-egg violation. Should pass cleanly.
			const res = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			});
			expect(res.status).toBe(200);
		});

		it("rejects requests when the version header doesn't match what THIS session negotiated", async () => {
			const sid = await freshSession();
			// Even though "9999-99-99" is well-formed, the session
			// negotiated 2024-11-05 — the per-session check must fire.
			const res = await postMcp(
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ "Mcp-Session-Id": sid, "MCP-Protocol-Version": "9999-99-99" }
			);
			expect(res.status).toBe(400);
			const err = JSON.parse(res.body);
			expect(err.error?.message).toMatch(/mismatch|negotiated|Unsupported/i);
		});
	});

	describe("batch lifecycle (no mixed initialize + other requests)", () => {
		// Codex's fourth pass found that the lifecycle gate was per-HTTP-
		// request, so a batch could mix initialize + tools/call and the
		// tools/call would execute before initialize had stamped the
		// session as authorized. These tests pin the rejection.

		it("rejects [initialize, tools/list] mixed in a single batch", async () => {
			const res = await postMcp([
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
				{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			]);
			expect(res.status).toBe(400);
			const err = JSON.parse(res.body);
			expect(err.error?.message).toMatch(/mix|initialize must complete/i);
		});

		it("rejects [tools/list, initialize] (order-independent)", async () => {
			const res = await postMcp([
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
			]);
			expect(res.status).toBe(400);
		});

		it("rejects multiple initialize requests in one batch", async () => {
			const res = await postMcp([
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
				{ jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
			]);
			expect(res.status).toBe(400);
			const err = JSON.parse(res.body);
			expect(err.error?.message).toMatch(/Multiple initialize/i);
		});

		it("rejects [initialize, tools/call-as-notification] (notification-via-id-omission bypass)", async () => {
			// The original mixed-batch guard counted only id-bearing
			// requests. tools/call without an id would slip through, but
			// the dispatcher would still invoke the tool handler — a real
			// lifecycle bypass for any side-effecting tool. Codex's
			// fifth pass found this; this regression test pins the fix.
			//
			// We use a server with a tracked stub so we can assert the
			// tool handler was never called.
			let toolHandlerInvocations = 0;
			server.stop();
			server = new McpHttpServer({
				onMessage: (req, reply) => {
					if (req.method === "initialize") {
						reply({
							result: {
								protocolVersion: "2024-11-05",
								capabilities: { tools: {} },
								serverInfo: { name: "test", version: "0" },
							},
						});
					} else if (req.method === "tools/call") {
						toolHandlerInvocations++;
						reply({ result: { content: [] } });
					} else {
						reply({ result: {} });
					}
				},
				authToken: TOKEN,
			});
			port = await server.start(0);

			const res = await postMcp([
				{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
				{
					// no id → notification. Without the fix, this slipped
					// through the batch check and the handler ran.
					jsonrpc: "2.0",
					method: "tools/call",
					params: { name: "create", arguments: { path: "x.md", file_text: "y" } },
				},
			]);
			expect(res.status).toBe(400);
			// And critically, the tool handler must NOT have been invoked
			// even though the batch was rejected at parse time.
			expect(toolHandlerInvocations).toBe(0);
		});

		it("drops a single non-notification method sent without id (e.g. tools/call without id)", async () => {
			// Even outside an initialize batch, sending `tools/call` as
			// a notification shouldn't dispatch the handler — that
			// pattern bypasses normal request/response observability and
			// has no legitimate use.
			let toolHandlerInvocations = 0;
			server.stop();
			server = new McpHttpServer({
				onMessage: (req, reply) => {
					if (req.method === "initialize") {
						reply({
							result: {
								protocolVersion: "2024-11-05",
								capabilities: { tools: {} },
								serverInfo: { name: "test", version: "0" },
							},
						});
					} else if (req.method === "tools/call") {
						toolHandlerInvocations++;
						reply({ result: { content: [] } });
					} else {
						reply({ result: {} });
					}
				},
				authToken: TOKEN,
			});
			port = await server.start(0);

			// Establish a valid session first
			const init = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			});
			const sid = init.headers["mcp-session-id"] as string;

			// Send tools/call without an id
			const res = await postMcp(
				{
					jsonrpc: "2.0",
					method: "tools/call",
					params: { name: "create", arguments: { path: "x.md", file_text: "y" } },
				},
				{ "Mcp-Session-Id": sid }
			);
			// The transport accepts notifications with 202; the message
			// just gets dropped silently before reaching the handler.
			expect(res.status).toBe(202);
			expect(toolHandlerInvocations).toBe(0);
		});

		it("still allows real notifications (notifications/initialized) on a valid session", async () => {
			// Sanity: the new dispatch filter targets non-notifications/*
			// methods; legitimate notifications must still get through.
			let initializedNotifReceived = false;
			server.stop();
			server = new McpHttpServer({
				onMessage: (req, reply) => {
					if (req.method === "initialize") {
						reply({
							result: {
								protocolVersion: "2024-11-05",
								capabilities: { tools: {} },
								serverInfo: { name: "test", version: "0" },
							},
						});
					} else if (req.method === "notifications/initialized") {
						initializedNotifReceived = true;
						reply({ result: {} });
					} else {
						reply({ result: {} });
					}
				},
				authToken: TOKEN,
			});
			port = await server.start(0);

			const init = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			});
			const sid = init.headers["mcp-session-id"] as string;

			const res = await postMcp(
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ "Mcp-Session-Id": sid }
			);
			expect(res.status).toBe(202);
			expect(initializedNotifReceived).toBe(true);
		});

		it("allows a batch of multiple non-initialize requests on a valid session", async () => {
			// Sanity: the rejection is specifically for batches *containing
			// initialize alongside other requests*. A batch of pure
			// tool/utility requests is fine.
			const init = await postMcp({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: {},
			});
			const sid = init.headers["mcp-session-id"] as string;
			const res = await postMcp(
				[
					{ jsonrpc: "2.0", id: 1, method: "tools/list" },
					{ jsonrpc: "2.0", id: 2, method: "ping" },
				],
				{ "Mcp-Session-Id": sid }
			);
			expect(res.status).toBe(200);
			const payload = JSON.parse(res.body);
			expect(Array.isArray(payload)).toBe(true);
			expect(payload).toHaveLength(2);
		});
	});

	describe("session lifecycle gate (failed initialize)", () => {
		// A session minted by a failed/errored initialize must NOT be
		// usable for tools/* — the handshake never completed.
		let errServer: McpHttpServer;
		let errPort: number;

		beforeEach(async () => {
			errServer = new McpHttpServer({
				onMessage: (req, reply) => {
					if (req.method === "initialize") {
						reply({
							error: {
								code: -32603,
								message: "init failed for test",
							},
						});
					} else {
						reply({ result: { ok: true } });
					}
				},
				authToken: TOKEN,
			});
			errPort = await errServer.start(0);
		});

		afterEach(() => {
			errServer.stop();
		});

		function postErr(
			body: any,
			extraHeaders: Record<string, string> = {}
		): Promise<FetchResult> {
			return fetchOnce(
				"POST",
				"/mcp",
				errPort,
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TOKEN}`,
					Accept: "application/json",
					...extraHeaders,
				},
				JSON.stringify(body)
			);
		}

		it("rejects post-init requests on a session whose initialize errored", async () => {
			const init = await postErr({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			});
			// The session is still minted (id in response header) — that's
			// spec-compliant — but protocolVersion never gets stamped
			// because the initialize response carried an error.
			const sid = init.headers["mcp-session-id"] as string;
			expect(sid).toBeTruthy();
			const initBody = JSON.parse(init.body);
			expect(initBody.error).toBeDefined();

			// Try to use the session as if everything were fine. Even with
			// a perfectly valid version header, it must fail because the
			// handshake never completed.
			const res = await postErr(
				{ jsonrpc: "2.0", id: 2, method: "tools/list" },
				{
					"Mcp-Session-Id": sid,
					"MCP-Protocol-Version": "2024-11-05",
				}
			);
			expect(res.status).toBe(400);
			const err = JSON.parse(res.body);
			expect(err.error?.message).toMatch(/initialization|initialize/i);
		});
	});

	describe("session idle expiry", () => {
		// Sweep is keyed off Date.now(); vi.setSystemTime fakes that for us.
		afterEach(() => {
			vi.useRealTimers();
		});

		it("expires idle sessions after 30 minutes of inactivity", async () => {
			vi.useFakeTimers({
				shouldAdvanceTime: true,
				toFake: ["Date"],
			});

			const init = await postMcp({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: {},
			});
			const sid = init.headers["mcp-session-id"] as string;
			expect(sid).toBeTruthy();

			// Push the system clock forward past the 30-minute idle window.
			// The next request triggers the sweep and the session is gone.
			vi.setSystemTime(Date.now() + 31 * 60 * 1000);

			const after = await postMcp(
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ "Mcp-Session-Id": sid }
			);
			expect(after.status).toBe(404);
			const err = JSON.parse(after.body);
			expect(err.error?.message).toMatch(/expired|unknown/i);
		});

		it("does NOT expire sessions still inside the idle window", async () => {
			vi.useFakeTimers({
				shouldAdvanceTime: true,
				toFake: ["Date"],
			});

			const init = await postMcp({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: {},
			});
			const sid = init.headers["mcp-session-id"] as string;

			vi.setSystemTime(Date.now() + 5 * 60 * 1000); // only 5 min

			const after = await postMcp(
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ "Mcp-Session-Id": sid }
			);
			expect(after.status).toBe(200);
		});
	});

	describe("DELETE /mcp", () => {
		it("returns 204 for a valid session id", async () => {
			const init = await postMcp({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
			});
			const sid = init.headers["mcp-session-id"] as string;

			const del = await fetchOnce("DELETE", "/mcp", port, {
				Authorization: `Bearer ${TOKEN}`,
				"Mcp-Session-Id": sid,
			});
			expect(del.status).toBe(204);

			// The session is gone — subsequent requests for it should 404
			const after = await postMcp(
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ "Mcp-Session-Id": sid }
			);
			expect(after.status).toBe(404);
		});

		it("returns 400 when called without Mcp-Session-Id", async () => {
			const res = await fetchOnce("DELETE", "/mcp", port, {
				Authorization: `Bearer ${TOKEN}`,
			});
			expect(res.status).toBe(400);
		});
	});
});
