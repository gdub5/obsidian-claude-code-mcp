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
	streams: Set<http.ServerResponse>;
}

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
		return this.activeStreams.size;
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
		} else {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32002,
						message: "Not found. Use /sse or /messages endpoints.",
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
		const session: Session = {
			id: sessionId,
			createdAt: Date.now(),
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
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Content-Type, Accept, Authorization, Last-Event-ID"
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
