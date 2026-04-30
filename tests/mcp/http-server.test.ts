import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
