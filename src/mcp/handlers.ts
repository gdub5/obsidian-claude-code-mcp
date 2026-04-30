import { App } from "obsidian";
import { WebSocket } from "ws";
import { McpRequest, McpReplyFunction } from "./types";
import { WorkspaceManager } from "../obsidian/workspace-manager";
import { ToolRegistry } from "../shared/tool-registry";
import { IdeHandler } from "../ide/ide-handler";

// HTTP-compatible reply function type
export interface HttpMcpReplyFunction {
	(msg: Omit<import("./types").McpResponse, "jsonrpc" | "id">): void;
}

/**
 * Protocol versions this server understands at the wire-format level.
 *
 * Order matters: this is preference order. When negotiating with a client,
 * we pick the version the client requested if it's in this set, otherwise
 * we fall back to the first entry (`LATEST`) and let the client decide
 * whether it can speak it.
 *
 * We support both the modern spec (2025-11-25) and the original spec
 * (2024-11-05) because the wire format requirements that affect this
 * server haven't materially diverged — Streamable HTTP, session ids,
 * notifications, capability negotiation. Newer spec features (sampling
 * tool calls, URL elicitation, tasks, icons) are optional and we don't
 * advertise capabilities we don't implement.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2024-11-05"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_NAME = "obsidian-claude-code-mcp";

/**
 * Pick the version we'll honor for this connection. The MCP spec
 * (2025-11-25/lifecycle#version-negotiation) tells servers to:
 *
 *   - reply with the SAME version the client requested if supported,
 *   - otherwise reply with the latest version the server supports.
 *
 * Client then decides whether it can speak our chosen version; if not,
 * it disconnects.
 */
function negotiateProtocolVersion(requested: unknown): string {
	if (
		typeof requested === "string" &&
		(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
	) {
		return requested;
	}
	return LATEST_PROTOCOL_VERSION;
}

export class McpHandlers {
	private wsToolRegistry: ToolRegistry;
	private httpToolRegistry: ToolRegistry;
	private ideHandler: IdeHandler;
	private serverVersion: string;

	constructor(
		private app: App,
		wsToolRegistry: ToolRegistry,
		httpToolRegistry: ToolRegistry,
		workspaceManager?: WorkspaceManager,
		serverVersion = "0.0.0-dev"
	) {
		this.wsToolRegistry = wsToolRegistry;
		this.httpToolRegistry = httpToolRegistry;
		this.ideHandler = new IdeHandler(app, workspaceManager);
		this.serverVersion = serverVersion;
	}

	async handleRequest(sock: WebSocket, req: McpRequest): Promise<void> {
		console.debug(`[MCP] Handling request: ${req.method}`, req.params);

		// Notifications (no `id` field) get no reply, per JSON-RPC 2.0.
		if (!isRequest(req)) {
			console.debug(`[MCP] Notification received: ${req.method}`);
			return;
		}

		const reply: McpReplyFunction = (msg) => {
			const response = JSON.stringify({
				jsonrpc: "2.0",
				id: req.id,
				...msg,
			});
			console.debug(
				`[MCP] Sending response for ${req.method}:`,
				response
			);
			sock.send(response);
		};

		return this.handleRequestGeneric(req, reply, "ws");
	}

	async handleHttpRequest(
		req: McpRequest,
		reply: HttpMcpReplyFunction
	): Promise<void> {
		console.debug(`[MCP HTTP] Handling request: ${req.method}`, req.params);

		// Notifications get no reply.
		if (!isRequest(req)) {
			console.debug(`[MCP HTTP] Notification received: ${req.method}`);
			return;
		}

		return this.handleRequestGeneric(req, reply, "http");
	}

	private async handleRequestGeneric(
		req: McpRequest,
		reply: McpReplyFunction | HttpMcpReplyFunction,
		source: "ws" | "http"
	): Promise<void> {
		// First check if it's an IDE-specific method
		if (this.ideHandler.isIdeMethod(req.method)) {
			const handled = await this.ideHandler.handleRequest(req, reply);
			if (handled) return;
		}

		switch (req.method) {
			case "initialize":
				return this.handleInitialize(req, reply);

			case "tools/list":
				return this.handleToolsList(req, reply, source);

			case "ping":
				return reply({ result: {} });

			case "tools/call": {
				const toolRegistry =
					source === "ws" ? this.wsToolRegistry : this.httpToolRegistry;
				return toolRegistry.handleToolCall(req, reply);
			}

			default:
				console.error(
					`[MCP] Unknown method called: ${req.method}`,
					req.params
				);
				return reply({
					error: { code: -32601, message: "Method not found" },
				});
		}
	}

	private async handleInitialize(
		req: McpRequest,
		reply: McpReplyFunction | HttpMcpReplyFunction
	): Promise<void> {
		try {
			const requestedVersion = (req.params as any)?.protocolVersion;
			const negotiatedVersion = negotiateProtocolVersion(requestedVersion);
			reply({
				result: {
					protocolVersion: negotiatedVersion,
					capabilities: {
						// Only advertise capabilities we actually implement.
						// `roots`, `sampling`, `elicitation` are CLIENT
						// capabilities per spec — never advertised by a
						// server. `prompts` and `resources` aren't
						// implemented yet so we don't advertise them
						// either (a client must not depend on them).
						tools: {
							listChanged: false,
						},
					},
					serverInfo: {
						name: SERVER_NAME,
						version: this.serverVersion,
					},
				},
			});
		} catch (error: any) {
			reply({
				error: {
					code: -32603,
					message: `failed to initialize: ${error.message}`,
				},
			});
		}
	}

	private async handleToolsList(
		_req: McpRequest,
		reply: McpReplyFunction | HttpMcpReplyFunction,
		source: "ws" | "http"
	): Promise<void> {
		try {
			const toolRegistry =
				source === "ws" ? this.wsToolRegistry : this.httpToolRegistry;
			const tools = toolRegistry.getToolDefinitions();
			reply({ result: { tools } });
		} catch (error: any) {
			reply({
				error: {
					code: -32603,
					message: `failed to list tools: ${error.message}`,
				},
			});
		}
	}
}

/**
 * A JSON-RPC message is a request (vs notification) iff it carries an `id`.
 * The spec allows id to be a string or number; null is reserved/discouraged.
 */
function isRequest(msg: McpRequest): boolean {
	return msg.id !== undefined && msg.id !== null;
}
