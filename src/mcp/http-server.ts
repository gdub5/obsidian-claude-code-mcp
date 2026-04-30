import * as http from "http";
import * as crypto from "crypto";
import { McpRequest, McpResponse, McpNotification } from "./types";
import { extractBearerToken, isAuthorized } from "./auth";

interface HttpReplyFunction {
	(msg: Omit<McpResponse, "jsonrpc" | "id">): void;
	stream?: (msg: McpNotification | McpResponse) => void;
	end?: () => void;
}

interface Session {
	id: string;
	createdAt: number;
	/**
	 * Last time we accepted any request bound to this session. Updated on
	 * every authenticated /mcp POST that touches the session and on every
	 * SSE message dispatch. Used to expire idle Streamable-HTTP sessions
	 * that would otherwise live forever (HTTP is request/response — there's
	 * no socket close to hook for cleanup).
	 */
	lastActivityAt: number;
	/**
	 * Negotiated MCP protocol version, captured from the `initialize` reply.
	 * Subsequent requests on the same session must send a matching
	 * `MCP-Protocol-Version` header. Null until initialize completes.
	 */
	protocolVersion: string | null;
	streams: Set<http.ServerResponse>;
}

/**
 * Streamable-HTTP sessions don't ride a long-lived socket, so we sweep
 * idle ones manually. 30 minutes covers a sleeping laptop / paused agent
 * comfortably without leaking authorized session ids forever.
 */
const MCP_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Versions the server actually implements. Clients sending a different
 * version on a post-initialize request are rejected before we dispatch.
 * Server can still accept the version requested in `initialize` (the
 * handler picks one to advertise back); this set guards subsequent
 * requests against version-skew bugs.
 */
const SUPPORTED_MCP_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
	"2024-11-05",
]);

interface SSEStream {
	response: http.ServerResponse;
	sessionId: string;
	lastEventId?: string;
}

export interface McpHttpServerConfig {
	onMessage: (request: McpRequest, reply: HttpReplyFunction) => void;
	onConnection?: () => void;
	onDisconnection?: () => void;
	/**
	 * Required bearer token. Empty/undefined refuses to start — there's no
	 * supported unauthenticated mode. Token can be supplied via the
	 * `Authorization: Bearer <token>` header or, on the SSE GET, the
	 * `?token=<token>` query parameter (since EventSource cannot set headers).
	 */
	authToken: string;
}

export class McpHttpServer {
	private server!: http.Server;
	private port = 0;
	private config: McpHttpServerConfig;
	private sessions: Map<string, Session> = new Map();
	private activeStreams: Set<SSEStream> = new Set();
	private eventIdCounter = 0;

	constructor(config: McpHttpServerConfig) {
		if (!config?.authToken) {
			throw new Error(
				"McpHttpServer requires a non-empty authToken — refusing to start without auth"
			);
		}
		this.config = config;
	}

	/** returns port number */
	async start(port = 22360): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) => {
				this.handleRequest(req, res);
			});

			this.server.on("error", (error: any) => {
				if (error.code === "EADDRINUSE") {
					console.error(`[MCP HTTP] Port ${port} is in use`);
					reject(error);
				} else {
					console.error("[MCP HTTP] Server error:", error);
					reject(error);
				}
			});

			this.server.listen(port, "127.0.0.1", () => {
				this.port = (this.server.address() as any)?.port || port;
				console.log(`[MCP HTTP] Server started on port ${this.port}`);
				resolve(this.port);
			});
		});
	}

	stop(): void {
		// Close all active SSE streams
		for (const stream of this.activeStreams) {
			stream.response.end();
		}
		this.activeStreams.clear();
		this.sessions.clear();

		this.server?.close();
		console.log("[MCP HTTP] Server stopped");
	}

	get clientCount(): number {
		// Sum SSE streams (legacy /sse + /messages clients) and bare
		// sessions (Streamable-HTTP /mcp clients). A session may be in
		// `sessions` and ALSO have streams attached (legacy path) — count
		// it once via the streams collection.
		const sseClients = this.activeStreams.size;
		let mcpClients = 0;
		for (const sess of this.sessions.values()) {
			if (sess.streams.size === 0) mcpClients++;
		}
		return sseClients + mcpClients;
	}

	/**
	 * Drop sessions that haven't been touched in
	 * `MCP_SESSION_IDLE_TIMEOUT_MS`. Called from the request hot path so
	 * we don't need a background timer. SSE-attached sessions are skipped
	 * — the underlying socket gives us a real close hook for those.
	 */
	private sweepExpiredSessions(): void {
		const cutoff = Date.now() - MCP_SESSION_IDLE_TIMEOUT_MS;
		for (const [id, sess] of this.sessions) {
			if (sess.streams.size > 0) continue; // managed by the SSE close hook
			if (sess.lastActivityAt < cutoff) {
				this.sessions.delete(id);
				this.config.onDisconnection?.();
			}
		}
	}

	get serverPort(): number {
		return this.port;
	}

	broadcast(message: McpNotification): void {
		const data = JSON.stringify(message);
		const eventId = ++this.eventIdCounter;

		for (const stream of this.activeStreams) {
			if (!stream.response.destroyed) {
				this.sendSSEMessage(
					stream.response,
					"message",
					data,
					eventId.toString()
				);
			}
		}
	}

	private async handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		// Add CORS headers
		this.setCORSHeaders(res);

		// Handle preflight requests
		if (req.method === "OPTIONS") {
			res.writeHead(200);
			res.end();
			return;
		}

		// Origin check — block cross-origin browser requests so a malicious
		// page on the user's machine can't hit the localhost server.
		if (!this.validateOrigin(req)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32001,
						message: "Forbidden origin",
					},
				})
			);
			return;
		}

		const url = new URL(req.url || "/", `http://${req.headers.host}`);

		// Authentication. Header preferred; on /sse GET we also accept
		// `?token=` because EventSource clients can't set headers.
		const presented =
			extractBearerToken(req.headers["authorization"]) ??
			(url.pathname === "/sse" && req.method === "GET"
				? url.searchParams.get("token")
				: null);

		if (!isAuthorized(this.config.authToken, presented)) {
			console.warn(
				`[MCP HTTP] Unauthorized request to ${req.method} ${url.pathname}`
			);
			res.writeHead(401, {
				"Content-Type": "application/json",
				"WWW-Authenticate": 'Bearer realm="obsidian-mcp"',
			});
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32001,
						message: "Unauthorized: missing or invalid bearer token",
					},
					id: null,
				})
			);
			return;
		}

		// Route to appropriate endpoint
		if (url.pathname === "/sse") {
			if (req.method === "GET") {
				await this.handleSSEConnection(req, res);
			} else {
				res.writeHead(405, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message: "Method not allowed. Use GET /sse",
						},
						id: null,
					})
				);
			}
		} else if (url.pathname === "/messages") {
			if (req.method === "POST") {
				await this.handleMessages(req, res, url);
			} else {
				res.writeHead(405, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message: "Method not allowed. Use POST /messages",
						},
						id: null,
					})
				);
			}
		} else if (url.pathname === "/mcp") {
			// Streamable HTTP transport (added in PR C, MCP spec 2025-03-26+).
			// Sits alongside the legacy /sse + /messages pair so existing
			// clients keep working unchanged.
			if (req.method === "POST") {
				await this.handleMcpPost(req, res);
			} else if (req.method === "GET") {
				// Server-initiated streams are optional in the spec and we
				// don't yet need them — broadcasts go over the legacy /sse
				// path. Refuse cleanly so a client that probes for stream
				// support gets an honest answer rather than a hang.
				res.writeHead(405, {
					"Content-Type": "application/json",
					Allow: "POST, OPTIONS",
				});
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message:
								"Server-initiated streams not supported on /mcp; use POST.",
						},
						id: null,
					})
				);
			} else if (req.method === "DELETE") {
				await this.handleMcpDelete(req, res);
			} else {
				res.writeHead(405, {
					"Content-Type": "application/json",
					Allow: "POST, DELETE, OPTIONS",
				});
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message: "Method not allowed on /mcp",
						},
						id: null,
					})
				);
			}
		} else {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32002,
						message:
							"Not found. Use /mcp (Streamable HTTP) or /sse + /messages (legacy SSE).",
					},
				})
			);
		}
	}

	private async handleSSEConnection(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		// Validate Accept header
		const accept = req.headers.accept || "";
		if (!accept.includes("text/event-stream")) {
			res.writeHead(406, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Must accept text/event-stream" }));
			return;
		}

		// Create new session
		const sessionId = crypto.randomUUID();
		const now = Date.now();
		const session: Session = {
			id: sessionId,
			createdAt: now,
			lastActivityAt: now,
			protocolVersion: null,
			streams: new Set([res]),
		};
		this.sessions.set(sessionId, session);

		// Set SSE headers (CORS already set globally on the response)
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		const lastEventId = req.headers["last-event-id"] as string;
		const stream: SSEStream = {
			response: res,
			sessionId,
			lastEventId,
		};

		this.activeStreams.add(stream);
		this.config.onConnection?.();

		// Send endpoint event immediately
		const messagesEndpoint = `/messages?session_id=${sessionId}`;
		this.sendSSEMessage(res, "endpoint", messagesEndpoint);

		// Handle client disconnect
		req.on("close", () => {
			this.activeStreams.delete(stream);
			this.sessions.delete(sessionId);
			this.config.onDisconnection?.();
		});

		// Send periodic ping to keep connection alive
		const pingInterval = setInterval(() => {
			if (res.destroyed) {
				clearInterval(pingInterval);
				return;
			}
			this.sendSSEMessage(res, "ping", new Date().toISOString());
		}, 30000);

		req.on("close", () => {
			clearInterval(pingInterval);
		});
	}

	private async handleMessages(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		url: URL
	): Promise<void> {
		const sessionId = url.searchParams.get("session_id");

		// Validate session
		if (!sessionId || !this.sessions.has(sessionId)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Session not found" }));
			return;
		}

		const session = this.sessions.get(sessionId)!;
		const body = await this.readRequestBody(req);
		let messages: any[];

		try {
			const parsed = JSON.parse(body);
			messages = Array.isArray(parsed) ? parsed : [parsed];
		} catch (error) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid JSON" }));
			return;
		}

		// Check if all messages are responses/notifications (no id + method)
		const hasRequests = messages.some(
			(msg) => msg.id !== undefined && msg.method !== undefined
		);

		if (!hasRequests) {
			// Only responses/notifications - return 202 Accepted
			for (const msg of messages) {
				if (msg.method) {
					// Handle notification
					this.config.onMessage(msg as McpRequest, () => {});
				}
			}
			res.writeHead(202);
			res.end();
			return;
		}

		// Process requests and send responses over SSE
		const stream = Array.from(this.activeStreams).find(
			(s) => s.sessionId === sessionId
		);
		if (!stream) {
			res.writeHead(410, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "SSE connection lost" }));
			return;
		}

		for (const request of messages) {
			if (request.method && request.id !== undefined) {
				const reply: HttpReplyFunction = (msg) => {
					const response: McpResponse = {
						jsonrpc: "2.0",
						id: request.id,
						...msg,
					};
					const eventId = ++this.eventIdCounter;
					this.sendSSEMessage(
						stream.response,
						"message",
						JSON.stringify(response),
						eventId.toString()
					);
				};

				// Add streaming capabilities
				reply.stream = (msg) => {
					const eventId = ++this.eventIdCounter;
					this.sendSSEMessage(
						stream.response,
						"message",
						JSON.stringify(msg),
						eventId.toString()
					);
				};

				reply.end = () => {
					stream.response.end();
				};

				this.config.onMessage(request as McpRequest, reply);
			}
		}

		// Return 202 Accepted for POST requests
		res.writeHead(202);
		res.end();
	}

	/**
	 * Handle a POST to the Streamable HTTP `/mcp` endpoint. Behavior:
	 *
	 *   1. Body is one JSON-RPC object or an array of them.
	 *   2. If every message is a notification or response (no `id`
	 *      paired with `method`), dispatch them and reply 202 Accepted.
	 *   3. Otherwise dispatch each request, collect the responses, and
	 *      reply with the response JSON (single object if one in / one out,
	 *      array if multiple).
	 *   4. On `initialize`, mint a session and return its id in the
	 *      `Mcp-Session-Id` response header. On every other request the
	 *      client MUST send the same id back as a header — we validate.
	 *   5. After init, the client MUST also send `MCP-Protocol-Version`.
	 *      We accept any version string (we currently implement
	 *      `2024-11-05`) — a client requesting a version we don't
	 *      implement gets the supported one back via the initialize
	 *      response and is responsible for adapting.
	 *
	 * Streaming responses (Content-Type: text/event-stream) are NOT used
	 * by this server because none of our handlers produce streamed output.
	 * If a future tool wants progress notifications we'll add it then.
	 */
	private async handleMcpPost(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		// Accept negotiation. We always reply with JSON; if the client
		// only accepts text/event-stream, that's a polite 406 — we don't
		// pretend to support streams we don't implement.
		const accept = (req.headers.accept || "").toLowerCase();
		const wantsJson = accept === "" || accept.includes("application/json") || accept.includes("*/*");
		if (!wantsJson) {
			res.writeHead(406, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message:
							"This server only returns application/json on /mcp; streaming responses are not supported.",
					},
					id: null,
				})
			);
			return;
		}

		const body = await this.readRequestBody(req);
		let messages: any[];
		try {
			const parsed = JSON.parse(body);
			messages = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32700, message: "Parse error" },
					id: null,
				})
			);
			return;
		}

		if (messages.length === 0) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32600, message: "Empty batch" },
					id: null,
				})
			);
			return;
		}

		// Sweep expired sessions before we look any up. Cheap (linear in
		// active session count, typically < 5) and avoids needing a
		// background timer that would have to be cleaned up on plugin
		// unload.
		this.sweepExpiredSessions();

		const sessionHeader = (req.headers["mcp-session-id"] as string) || null;
		const isInitializeBatch = messages.some(
			(m) => m && m.method === "initialize" && m.id !== undefined
		);

		// Session validation
		// - On initialize: client sends NO session id; we mint one.
		// - On every other request: client MUST send the session id we
		//   gave them. Reject with 404 if missing or unknown — matches
		//   the spec's "session not found" semantics.
		let sessionId: string;
		const now = Date.now();
		if (isInitializeBatch) {
			sessionId = sessionHeader && this.sessions.has(sessionHeader)
				? sessionHeader
				: crypto.randomUUID();
			if (!this.sessions.has(sessionId)) {
				this.sessions.set(sessionId, {
					id: sessionId,
					createdAt: now,
					lastActivityAt: now,
					protocolVersion: null,
					streams: new Set(),
				});
				this.config.onConnection?.();
			}
		} else {
			if (!sessionHeader) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32600,
							message:
								"Missing Mcp-Session-Id header (required after initialize)",
						},
						id: null,
					})
				);
				return;
			}
			if (!this.sessions.has(sessionHeader)) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32600,
							message: "Unknown Mcp-Session-Id (session expired or never opened)",
						},
						id: null,
					})
				);
				return;
			}
			sessionId = sessionHeader;

			// Spec requires every post-initialize request to carry
			// `MCP-Protocol-Version`. We enforce it strictly: missing or
			// unsupported → 400. This catches version-skew bugs where a
			// client successfully initialized but then fails to advertise
			// the version on subsequent calls.
			const versionHeader = req.headers["mcp-protocol-version"];
			const presentedVersion = Array.isArray(versionHeader)
				? versionHeader[0]
				: versionHeader;
			if (!presentedVersion) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32600,
							message:
								"Missing MCP-Protocol-Version header (required after initialize)",
						},
						id: null,
					})
				);
				return;
			}
			if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.has(presentedVersion)) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32600,
							message: `Unsupported MCP-Protocol-Version: ${presentedVersion}. Server supports: ${[
								...SUPPORTED_MCP_PROTOCOL_VERSIONS,
							].join(", ")}`,
						},
						id: null,
					})
				);
				return;
			}
		}

		// Touch the session — every accepted request resets the idle clock.
		const sess = this.sessions.get(sessionId)!;
		sess.lastActivityAt = now;

		// Dispatch each message. For requests, collect the response;
		// for notifications, fire-and-forget.
		const responses: McpResponse[] = [];
		for (const msg of messages) {
			if (!msg || typeof msg !== "object") continue;
			const isRequest = msg.id !== undefined && typeof msg.method === "string";
			const isNotification = msg.id === undefined && typeof msg.method === "string";

			if (isRequest) {
				const response = await dispatchAndCollect(
					msg as McpRequest,
					this.config.onMessage
				);
				responses.push(response);

				// Capture the negotiated protocol version off the
				// initialize response so we can validate the header
				// the client must send on every subsequent request.
				if (msg.method === "initialize" && response.result?.protocolVersion) {
					sess.protocolVersion = response.result.protocolVersion;
				}
			} else if (isNotification) {
				// Fire-and-forget — handlers ignore the no-op reply.
				this.config.onMessage(msg as McpRequest, () => {});
			}
			// Anything else (orphan response, malformed) is silently dropped.
		}

		// Set Mcp-Session-Id on every response so clients have one source
		// of truth, not just initialize replies.
		res.setHeader("Mcp-Session-Id", sessionId);

		// All notifications → 202 Accepted, no body.
		if (responses.length === 0) {
			res.writeHead(202);
			res.end();
			return;
		}

		// Return single object or array based on input shape (mirrors how
		// JSON-RPC batching works in the legacy /messages endpoint).
		const wasBatch = Array.isArray(JSON.parse(body));
		const payload = wasBatch ? responses : responses[0];

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(payload));
	}

	/**
	 * Explicit session termination via DELETE /mcp + Mcp-Session-Id header.
	 * Optional in the spec but cheap to support; lets clients release
	 * server-side state cleanly when they're done.
	 */
	private async handleMcpDelete(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		const sessionId = (req.headers["mcp-session-id"] as string) || null;
		if (!sessionId) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32600,
						message: "DELETE /mcp requires Mcp-Session-Id header",
					},
					id: null,
				})
			);
			return;
		}
		if (this.sessions.delete(sessionId)) {
			this.config.onDisconnection?.();
		}
		res.writeHead(204);
		res.end();
	}

	private sendSSEMessage(
		res: http.ServerResponse,
		event: string,
		data: string,
		id?: string
	): void {
		if (res.destroyed) return;

		if (id) {
			res.write(`id: ${id}\n`);
		}
		res.write(`event: ${event}\n`);
		res.write(`data: ${data}\n\n`);
	}

	private async readRequestBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				resolve(body);
			});
			req.on("error", reject);
		});
	}

	private setCORSHeaders(res: http.ServerResponse): void {
		// Only the loopback origins are allowed to read; anything else is
		// blocked at validateOrigin() before this point. We don't reflect
		// arbitrary Origin headers.
		res.setHeader("Access-Control-Allow-Origin", "http://localhost");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader(
			"Access-Control-Allow-Headers",
			// Mcp-Session-Id and MCP-Protocol-Version are required by the
			// Streamable HTTP transport (added in PR C). Last-Event-ID is
			// kept for the legacy SSE path.
			"Content-Type, Accept, Authorization, Last-Event-ID, Mcp-Session-Id, MCP-Protocol-Version"
		);
		res.setHeader(
			"Access-Control-Expose-Headers",
			"Mcp-Session-Id, MCP-Protocol-Version"
		);
		res.setHeader("Access-Control-Max-Age", "86400");
	}

	/**
	 * Allow only requests that come from the local machine. Native MCP
	 * clients (Claude Desktop, mcp-remote bridge, raw curl) typically send
	 * no Origin header at all, which we accept. Browser-originated requests
	 * carry an Origin header — we allow it only if it's a loopback host.
	 */
	private validateOrigin(req: http.IncomingMessage): boolean {
		const origin = req.headers["origin"];
		if (!origin) return true; // native client — no browser context

		try {
			const { hostname } = new URL(origin);
			return (
				hostname === "localhost" ||
				hostname === "127.0.0.1" ||
				hostname === "[::1]" ||
				hostname === "::1"
			);
		} catch {
			return false;
		}
	}
}

/**
 * Bridge between the existing onMessage(req, reply) callback shape and a
 * Promise-returning function. The handler chain calls `reply(msg)` at most
 * once with the response payload (sans `jsonrpc` / `id`); we wrap that
 * payload with the framing so the caller gets a complete McpResponse.
 *
 * Times out after 10s as a defense against a handler that never replies —
 * the transport layer should never hang an HTTP request indefinitely.
 */
function dispatchAndCollect(
	req: McpRequest,
	dispatch: (request: McpRequest, reply: (msg: any) => void) => void
): Promise<McpResponse> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve({
					jsonrpc: "2.0",
					id: req.id,
					error: {
						code: -32603,
						message: "Handler timed out waiting for reply",
					},
				});
			}
		}, 10_000);

		dispatch(req, (msg) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				jsonrpc: "2.0",
				id: req.id,
				...msg,
			});
		});
	});
}


