# Claude Code WebSocket Protocol Documentation

This document describes the WebSocket-based Model Context Protocol (MCP) that Claude Code uses to communicate with IDE integrations.

## Overview

Claude Code uses a custom WebSocket-based variant of the Model Context Protocol (MCP) for IDE integration. This protocol enables real-time communication between the Claude CLI and running IDE instances.

## Discovery Mechanism

### Lock File System

Claude Code discovers IDE instances through lock files stored in the Claude configuration directory's `ide` subdirectory. The config directory is resolved in the following order:

1. `$CLAUDE_CONFIG_DIR/ide/` (if CLAUDE_CONFIG_DIR env var is set)
2. `$XDG_CONFIG_HOME/claude/ide/` or `~/.config/claude/ide/` (new default since v1.0.30)
3. `~/.claude/ide/` (legacy location, used as fallback)

The actual location depends on which directory exists or which Claude Code creates:

1. **Lock File Location**: `<claude-config-dir>/ide/[port].lock`
2. **Naming Convention**: The filename MUST be the WebSocket port number
3. **File Format**: JSON containing connection metadata

### Lock File Structure

```json
{
  "pid": process_id,
  "workspaceFolders": ["/absolute/path/to/workspace"],
  "ideName": "IDE Name",
  "transport": "ws",
  "authToken": "<per-vault bearer token>"
}
```

**Critical Implementation Notes:**
- Lock file MUST be named `[port].lock` where `port` is the WebSocket server port
- Claude Code CLI scans this directory to discover available IDE connections
- The `workspaceFolders` array should contain absolute paths to workspace roots
- The `authToken` field carries the per-vault bearer token. Claude Code reads it
  from the lock file and presents it on the WebSocket upgrade request; the server
  rejects upgrades without a valid token (see [Authentication](#authentication)).

## WebSocket Server Configuration

### Server Setup

```javascript
const server = new WebSocketServer({ 
  port: 0,           // Random available port
  host: 'localhost'  // Bind to localhost only for security
});

const port = server.address().port;
```

### Connection Flow

1. IDE creates WebSocket server on random port (typically 10000-65535)
2. IDE writes lock file to `<claude-config-dir>/ide/[port].lock`
3. Claude Code CLI scans lock files and discovers available connections
4. User selects IDE via `/ide` command in Claude
5. Claude CLI connects to WebSocket server on discovered port

## Message Protocol

### Transport Details

- **Protocol**: WebSocket (RFC 6455 compliant)
- **Message Format**: JSON-RPC 2.0
- **Security**: Localhost-only binding (127.0.0.1)

### Message Structure

All messages follow JSON-RPC 2.0 specification:

```typescript
interface McpRequest {
  jsonrpc: "2.0";
  method: string;
  params?: any;
  id: string | number;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: { code: number; message: string };
}
```

## Supported MCP Methods

This plugin speaks standard MCP. There are **no** custom JSON-RPC method aliases
such as `readFile`/`writeFile`/`listFiles` — all file, workspace, and
knowledge-graph operations are exposed as **tools** and invoked through
`tools/call`. The core methods the server handles are:

| Method | Type | Purpose |
| --- | --- | --- |
| `initialize` | request | Handshake; negotiates protocol version and returns server capabilities |
| `notifications/initialized` | notification | Client signals it's ready; no response is sent |
| `tools/list` | request | Returns the available tool definitions (with input schemas and safety annotations) |
| `tools/call` | request | Invokes a named tool with arguments |
| `ping` | request | Liveness check; returns an empty result |

The IDE/WebSocket transport additionally handles the `ide_connected` notification
during connection setup (see `src/ide/ide-handler.ts`).

### `initialize`

The client sends its requested protocol version; the server negotiates against
the versions it supports (`2025-11-25` preferred, `2024-11-05` legacy) and echoes
the chosen version back along with its capabilities and instructions.

```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {},
    "clientInfo": { "name": "claude-code", "version": "x.y.z" }
  },
  "id": 1
}
```

Response (version-negotiated; tools capability advertised):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "obsidian-claude-code-mcp", "version": "1.1.13" }
  }
}
```

### `tools/list`

Returns the registered tools. The set depends on the transport: shared tools
(`view`, `str_replace`, `create`, `insert`, `get_current_file`,
`get_workspace_files`, `get_frontmatter`, `get_backlinks`, `get_outgoing_links`,
`list_tags`, `find_by_tag`, `search_vault`, `obsidian_api`) are available on both
the WebSocket and HTTP transports; IDE-specific tools (`getDiagnostics`,
`openDiff`, `close_tab`, `closeAllDiffTabs`) are WebSocket-only.

### `tools/call`

Invokes a tool by name. Example — read a file via the `view` tool:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "view",
    "arguments": { "path": "relative/path/to/file.md" }
  },
  "id": 2
}
```

Response (MCP tool-result content blocks):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [{ "type": "text", "text": "file contents here" }],
    "isError": false
  }
}
```

## Protocol Version Negotiation

The server supports two MCP specification versions and negotiates per connection:

- **`2025-11-25`** — modern Streamable HTTP transport, preferred/default.
- **`2024-11-05`** — legacy "HTTP with SSE" transport, kept for older clients.

On `initialize`, the client's requested `protocolVersion` is matched against the
supported set; if the client requests a version the server doesn't support, the
server replies with its preferred version (and, on the Streamable HTTP transport,
locks the session to the negotiated version — see below).

## Transports

Three transports are available, all gated by the bearer token:

1. **WebSocket** (this document's focus) — used by Claude Code via lock-file
   discovery. Token presented on the upgrade request.
2. **Streamable HTTP** — `POST`/`DELETE` on `/mcp` (MCP `2025-11-25`). Uses an
   `Mcp-Session-Id` header (minted at `initialize`, required on subsequent
   requests) and an `MCP-Protocol-Version` header after initialize.
3. **Legacy HTTP/SSE** — `GET /sse` + `POST /messages` (MCP `2024-11-05`).

For HTTP client configuration (URLs, headers, `mcp-remote` bridge), see the
**MCP Client Configuration** section of the project `README.md`.

## Authentication

Both transports require a per-vault bearer token (auto-generated on first plugin
load, rotatable in settings):

- **WebSocket**: the token is written into the `[port].lock` file (`authToken`
  field) and presented on the upgrade request. Upgrades without a valid token are
  rejected.
- **HTTP/SSE and Streamable HTTP**: send `Authorization: Bearer <token>`. The
  legacy SSE `GET` endpoint also accepts `?token=<token>` as a query parameter
  for clients that can't set custom headers. The HTTP server binds to `127.0.0.1`
  only and rejects non-loopback `Origin` headers.

## Error Handling

### Standard JSON-RPC Error Codes

- `-32700`: Parse error (Invalid JSON)
- `-32600`: Invalid Request
- `-32601`: Method not found
- `-32602`: Invalid params
- `-32603`: Internal error

### Custom Error Responses

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32603,
    "message": "failed to read file: File not found"
  }
}
```

## Security Considerations

### Network Security
- WebSocket server MUST bind to localhost only (`127.0.0.1`)
- No external network access should be allowed
- Use random ports to avoid conflicts

### File System Security
- Validate all file paths to prevent directory traversal
- Restrict operations to workspace boundaries
- Sanitize user input in file operations

### Path Validation Example

```javascript
function normalizePath(path) {
  // Remove leading slash for vault-relative paths
  const cleaned = path.startsWith("/") ? path.slice(1) : path;
  
  // Prevent directory traversal
  if (cleaned.includes("..") || cleaned.includes("~")) {
    return null;
  }
  
  return cleaned;
}
```

## Implementation Reference

This protocol specification is based on the implementation found in:
- **coder/claudecode.nvim**: Reference Neovim implementation
- **Source**: https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md

For troubleshooting IDE connection issues, refer to this protocol documentation and ensure:
1. Lock file is named correctly (`[port].lock`)
2. WebSocket server is bound to localhost
3. JSON-RPC message format is followed exactly
4. File paths are properly validated and normalized

## Debugging Connection Issues

### Common Problems

1. **"IDE disconnected" error**:
   - Check lock file naming convention
   - Verify WebSocket server is actually listening
   - Ensure port number in filename matches server port

2. **Claude can't discover IDE**:
   - Verify lock file exists in the correct config directory's `ide/` subdirectory
   - Check which config directory Claude Code is using (see discovery mechanism above)
   - Check lock file JSON format
   - Ensure `workspaceFolders` contains absolute paths

3. **WebSocket connection fails**:
   - Confirm server binds to localhost
   - Check for port conflicts
   - Verify firewall/security software isn't blocking localhost connections

### Debug Tools

```bash
# Check lock files (try each possible location)
# Modern location
ls -la ~/.config/claude/ide/
# Legacy location
ls -la ~/.claude/ide/
# Or if CLAUDE_CONFIG_DIR is set
ls -la "$CLAUDE_CONFIG_DIR/ide/"

# Verify lock file content (use the directory that exists)
cat ~/.config/claude/ide/[port].lock  # or
cat ~/.claude/ide/[port].lock

# Test WebSocket connectivity
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: test" -H "Sec-WebSocket-Version: 13" \
  http://localhost:[port]/
```