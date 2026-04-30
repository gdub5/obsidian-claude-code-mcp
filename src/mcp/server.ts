import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";
import { McpRequest, McpNotification } from "./types";
import { getClaudeIdeDir } from "../claude-config";
import { extractBearerToken, isAuthorized } from "./auth";

export interface McpServerConfig {
	onMessage: (ws: WebSocket, request: McpRequest) => void;
	onConnection?: (ws: WebSocket) => void;
	onDisconnection?: (ws: WebSocket) => void;
	/**
	 * Required token for connecting clients. Must be present and match the
	 * value Claude Code reads from the lock file. Empty/undefined disables
	 * the server — we never start an unauthenticated WebSocket.
	 */
	authToken: string;
}

// Header Claude Code sends on the WebSocket upgrade. Lowercased, since
// Node normalizes incoming headers to lowercase.
const CLAUDE_AUTH_HEADER = "x-claude-code-ide-authorization";

export class McpServer {
	private wss!: WebSocketServer;
	private lockFilePath = "";
	private connectedClients: Set<WebSocket> = new Set();
	private config: McpServerConfig;
	private port: number = 0;

	constructor(config: McpServerConfig) {
		if (!config.authToken) {
			throw new Error(
				"McpServer requires a non-empty authToken — refusing to start without auth"
			);
		}
		this.config = config;
	}

	async start(): Promise<number> {
		// 0 = choose a random free port
		this.wss = new WebSocketServer({
			port: 0,
			verifyClient: (info, cb) => {
				const presented =
					extractBearerToken(info.req.headers[CLAUDE_AUTH_HEADER]) ??
					extractBearerToken(info.req.headers["authorization"]);

				if (isAuthorized(this.config.authToken, presented)) {
					cb(true);
				} else {
					console.warn(
						"[MCP] WebSocket upgrade rejected: missing/invalid auth token"
					);
					cb(false, 401, "Unauthorized");
				}
			},
		});

		// address() is cast-safe once server is listening
		this.port = (this.wss.address() as any).port as number;

		this.wss.on("connection", (sock: WebSocket) => {
			console.debug("[MCP] Client connected");
			this.connectedClients.add(sock);
			console.debug(`[MCP] Total connected clients: ${this.connectedClients.size}`);

			sock.on("message", (data) => {
				this.handleMessage(sock, data.toString());
			});

			sock.on("close", () => {
				console.debug("[MCP] Client disconnected");
				this.connectedClients.delete(sock);
				console.debug(`[MCP] Total connected clients: ${this.connectedClients.size}`);
				this.config.onDisconnection?.(sock);
			});

			sock.on("error", (error) => {
				console.debug("[MCP] Client error:", error);
				this.connectedClients.delete(sock);
			});

			this.config.onConnection?.(sock);
		});

		this.wss.on("error", (error) => {
			console.error("WebSocket server error:", error);
		});

		// Write the discovery lock-file Claude looks for. Token is included
		// so the CLI can read it and present it on the upgrade request.
		await this.createLockFile(this.port);

		// Set environment variables that Claude Code CLI expects
		process.env.CLAUDE_CODE_SSE_PORT = this.port.toString();
		process.env.ENABLE_IDE_INTEGRATION = "true";

		return this.port;
	}

	stop(): void {
		this.wss?.close();
		if (this.lockFilePath && fs.existsSync(this.lockFilePath)) {
			fs.unlinkSync(this.lockFilePath);
		}
	}

	broadcast(message: McpNotification): void {
		const messageStr = JSON.stringify(message);
		console.debug("[MCP] Broadcasting message:", messageStr);
		for (const client of this.connectedClients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(messageStr);
			}
		}
	}

	get clientCount(): number {
		const count = this.connectedClients.size;
		console.debug(`[MCP] WebSocket server clientCount getter called: ${count}`);
		return count;
	}

	get serverPort(): number {
		return this.port;
	}

	private async createLockFile(port: number): Promise<void> {
		const ideDir = getClaudeIdeDir();
		fs.mkdirSync(ideDir, { recursive: true });

		this.lockFilePath = path.join(ideDir, `${port}.lock`);

		const lockFileContent = {
			pid: process.pid,
			workspaceFolders: [], // Will be populated by caller
			ideName: "Obsidian",
			transport: "ws",
			authToken: this.config.authToken,
		};
		fs.writeFileSync(this.lockFilePath, JSON.stringify(lockFileContent));
	}

	updateWorkspaceFolders(basePath: string): void {
		if (this.lockFilePath && fs.existsSync(this.lockFilePath)) {
			const lockContent = JSON.parse(fs.readFileSync(this.lockFilePath, 'utf8'));
			lockContent.workspaceFolders = [basePath];
			// Preserve the authToken across rewrites
			lockContent.authToken = this.config.authToken;
			fs.writeFileSync(this.lockFilePath, JSON.stringify(lockContent));
		}
	}

	private handleMessage(sock: WebSocket, raw: string): void {
		console.debug("[MCP] Received message:", raw);
		let req: McpRequest;
		try {
			req = JSON.parse(raw);
		} catch {
			console.debug("[MCP] Invalid JSON received:", raw);
			return; // ignore invalid JSON
		}

		this.config.onMessage(sock, req);
	}
}
