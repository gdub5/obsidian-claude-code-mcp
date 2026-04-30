export interface McpRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: any;
}

export interface McpResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: any;
	error?: { code: number; message: string };
}

export interface McpNotification {
	jsonrpc: "2.0";
	method: string;
	params?: any;
}

export interface SelectionRange {
	start: { line: number; character: number };
	end: { line: number; character: number };
	isEmpty: boolean;
}

export interface SelectionChangedParams {
	text: string;
	filePath: string | null;
	fileUrl: string | null;
	selection: SelectionRange;
}

/**
 * Per-tool safety hints, added in MCP spec 2025-03-26 and refined since.
 * These are *advisory* — clients use them to decide whether to auto-
 * approve a call, rate-limit, or surface a stronger confirmation prompt.
 *
 * All fields are optional. A missing field means "unspecified", which
 * clients should treat conservatively (e.g. unknown destructiveness =
 * assume destructive).
 *
 *   - title:           human-readable display name
 *   - readOnlyHint:    tool does not modify any state observable to other clients
 *   - destructiveHint: tool may permanently change or remove data
 *   - idempotentHint:  calling N times has the same effect as calling once
 *   - openWorldHint:   tool can reach outside the vault (network, OS, etc.)
 */
export interface ToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface Tool {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, any>;
	};
	annotations?: ToolAnnotations;
}

export type McpReplyFunction = (msg: Omit<McpResponse, "jsonrpc" | "id">) => void;