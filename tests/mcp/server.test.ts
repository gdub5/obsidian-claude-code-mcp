import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WebSocket } from "ws";
import { McpServer } from "../../src/mcp/server";

const TOKEN = "abcd1234".repeat(8); // 64 chars

let tmpConfigDir: string;

beforeAll(() => {
	// Redirect the Claude config dir into a per-run tempdir so the lock-file
	// writes never touch the user's real ~/.config/claude/ide directory.
	tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-test-"));
	process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
});

describe("McpServer construction", () => {
	it("refuses to construct without an auth token", () => {
		expect(
			() =>
				new McpServer({
					onMessage: () => {},
					authToken: "",
				})
		).toThrow(/authToken/);
	});
});

describe("McpServer auth + lock file", () => {
	let server: McpServer;
	let port: number;

	beforeEach(async () => {
		server = new McpServer({
			onMessage: () => {},
			authToken: TOKEN,
		});
		port = await server.start();
	});

	afterEach(() => {
		server.stop();
	});

	it("writes the auth token into the discovery lock file", () => {
		const lockPath = path.join(tmpConfigDir, "ide", `${port}.lock`);
		expect(fs.existsSync(lockPath)).toBe(true);

		const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
		expect(lock.authToken).toBe(TOKEN);
		expect(lock.transport).toBe("ws");
		expect(lock.ideName).toBe("Obsidian");
		expect(lock.pid).toBe(process.pid);
	});

	it("removes the lock file on stop()", () => {
		const lockPath = path.join(tmpConfigDir, "ide", `${port}.lock`);
		expect(fs.existsSync(lockPath)).toBe(true);
		server.stop();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("preserves authToken when updateWorkspaceFolders rewrites the lock", () => {
		server.updateWorkspaceFolders("/some/workspace");
		const lockPath = path.join(tmpConfigDir, "ide", `${port}.lock`);
		const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
		expect(lock.authToken).toBe(TOKEN);
		expect(lock.workspaceFolders).toEqual(["/some/workspace"]);
	});

	it("rejects WebSocket upgrade with no auth header", async () => {
		const result = await connectWs(port, {});
		expect(result.kind).toBe("rejected");
		if (result.kind === "rejected") {
			expect(result.statusCode).toBe(401);
		}
	});

	it("rejects WebSocket upgrade with the wrong token", async () => {
		const result = await connectWs(port, {
			"x-claude-code-ide-authorization": "wrong-token",
		});
		expect(result.kind).toBe("rejected");
		if (result.kind === "rejected") {
			expect(result.statusCode).toBe(401);
		}
	});

	it("accepts WebSocket upgrade with the correct token (Claude Code IDE header)", async () => {
		const result = await connectWs(port, {
			"x-claude-code-ide-authorization": TOKEN,
		});
		expect(result.kind).toBe("connected");
	});

	it("accepts WebSocket upgrade with the standard Authorization header", async () => {
		const result = await connectWs(port, {
			Authorization: `Bearer ${TOKEN}`,
		});
		expect(result.kind).toBe("connected");
	});
});

type WsResult =
	| { kind: "connected" }
	| { kind: "rejected"; statusCode: number };

function connectWs(
	port: number,
	headers: Record<string, string>
): Promise<WsResult> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
		const cleanup = () => {
			try {
				ws.close();
			} catch {
				// ignore
			}
		};
		ws.on("open", () => {
			cleanup();
			resolve({ kind: "connected" });
		});
		ws.on("unexpected-response", (_req, res) => {
			cleanup();
			resolve({ kind: "rejected", statusCode: res.statusCode ?? 0 });
		});
		ws.on("error", () => {
			// `unexpected-response` fires for HTTP errors; `error` fires for
			// transport problems. If we already resolved above we ignore.
		});
	});
}
