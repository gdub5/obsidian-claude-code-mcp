# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Obsidian plugin that implements MCP (Model Context Protocol) servers to enable Claude Code and Claude Desktop integration with Obsidian vaults. The plugin provides both WebSocket (for Claude Code CLI) and HTTP/SSE (for Claude Desktop) transports for maximum compatibility.

## Development Commands

- `bun install` - Install dependencies
- `bun run dev` - Start compilation in watch mode
- `bun run build` - Type check and build for production
- `bun run test` - Run the Vitest suite once
- `bun run test:watch` - Run Vitest in watch mode
- `bun run test:coverage` - Run tests with coverage report
- `bun run version patch|minor|major` - Bump version and update manifest files
- `eslint main.ts` - Run linting

## Architecture

### Core Components

- **main.ts** - Plugin entry point that orchestrates initialization, settings management, and server lifecycle
- **src/settings.ts** - Settings management, real-time server status display, and `ensureAuthToken` helper
- **src/mcp/** - MCP protocol implementation
  - **dual-server.ts** - Manages both WebSocket and HTTP servers with tool registry
  - **server.ts** - WebSocket server for Claude Code CLI integration; gates upgrades on bearer token
  - **http-server.ts** - HTTP/SSE server for Claude Desktop (uses MCP spec 2024-11-05); gates requests on bearer token + origin
  - **handlers.ts** - Request routing; honors JSON-RPC notifications (no reply)
  - **auth.ts** - Token generation, bearer-header parsing, constant-time comparison
  - **types.ts** - TypeScript interfaces for MCP protocol
- **src/ide/** - Claude Code IDE-specific functionality
  - **ide-handler.ts** - Handles IDE-specific requests (ide_connected, etc.)
  - **ide-tools.ts** - IDE-specific tool implementations (openDiff, close_tab, etc.)
- **src/shared/** - Common functionality
  - **tool-registry.ts** - Automatic tool registration and validation system
- **src/obsidian/** - Obsidian API integration
  - **workspace-manager.ts** - Tracks active file and selection using DOM events
  - **utils.ts** - Path normalization and validation utilities
- **src/tools/** - MCP tool implementations
  - **general-tools.ts** - General workspace and file manipulation tools
- **src/terminal/** - Optional embedded terminal feature
  - **terminal-view.ts** - Terminal UI implementation using xterm.js
  - **pseudoterminal.ts** - Platform-specific terminal spawning
  - **python-detection.ts** - Python environment detection
- **tests/** - Vitest suite (utils, tool registry, handlers, auth, HTTP/WS servers)
  - **mocks/obsidian.ts** - Hand-rolled mock of the `obsidian` module surface used in tests

### MCP Tools Implemented

All tools are reached via the standard MCP `tools/call` request — there are no
direct JSON-RPC method aliases.

**Available for both IDE and MCP:**
- `view` - View file contents with optional line ranges, or list a directory
- `str_replace` - Replace exact text in a file
- `create` - Create a new file
- `insert` - Insert text at a specific line number
- `get_current_file` - Get the currently active file
- `get_workspace_files` - List all files in vault (optional pattern)
- `obsidian_api` - Execute arbitrary Obsidian API code (powerful — use carefully)

**IDE-specific tools (WebSocket only):**
- `getDiagnostics` - Return file diagnostics
- `openDiff` - Open diff view for file changes
- `close_tab` - Close specific tabs
- `closeAllDiffTabs` - Close all diff views

### Key Design Patterns

- **Event-Driven Architecture** - Uses DOM `selectionchange` events instead of polling
- **Lazy Loading** - Terminal features loaded only when needed
- **Proper Cleanup** - All event listeners registered via Obsidian's system
- **Error Boundaries** - Graceful error handling with user notifications
- **Port Conflict Detection** - Automatic detection with guidance for resolution
- **Tool Registry** - Automatic tool registration with runtime validation
- **Separation of Concerns** - IDE-specific code isolated from standard MCP protocol
- **Dual Tool Registries** - Separate tool sets for WebSocket/IDE vs HTTP/MCP servers

## Building and Testing

### Build System
- Uses esbuild with custom configuration (esbuild.config.mjs)
- Bundles to single main.js file (CommonJS format)
- PNG files bundled as data URLs
- Python scripts bundled as text

### Automated Tests

**Unit tests (Vitest)** — `tests/**/*.test.ts`. Run with `bun run test`.
- The `obsidian` module is aliased to `tests/mocks/obsidian.ts` so non-UI code
  can be exercised without a live Obsidian runtime.
- Server-level tests (`tests/mcp/server.test.ts`, `tests/mcp/http-server.test.ts`)
  bind to ephemeral ports and redirect the Claude config dir to a tempdir, so
  they leave nothing behind on the developer's machine.

**Integration stress harness** — `tests/integration/stress.mjs`. Drives a real
plugin instance over the live HTTP/SSE transport. Run with:
```
MCP_TOKEN=<token-from-test-vault-settings> bun run test:integration
```
- Defaults to `http://localhost:48888` (the test vault's port). Override with
  `MCP_URL=...` or pass as a CLI arg.
- Scoped to the `__scratch__/` folder in the target vault — never touches
  pinned fixture files.
- Surfaces known bugs as warnings so CI can stay green while bug fixes are
  pending in PR B.

### Test Vault

A dedicated Obsidian vault at `~/Documents/Obsidian/mcptestvault` holds
controlled fixture content for integration testing. The plugin in that vault
runs on **port 48888** (not the production 22360) to avoid collision.

Fixture content is in `test-fixtures/vault/` (committed). The link topology,
tag distribution, and edge-case filenames are deliberate and pinned — see
`test-fixtures/README.md` for the contract.

**Reset / refresh the test vault:**
```
bun run test-vault:setup
# or override the path:
TEST_VAULT_PATH=/path/to/vault bun run test-vault:setup
```
This wipes everything outside `.obsidian/` and re-copies the fixtures. After
running, reload the vault in Obsidian (Cmd-R in that window) so MetadataCache
re-indexes.

The script refuses to wipe a directory it doesn't recognize as a test vault
(must be effectively empty or carry the test-vault README marker), so it's
safe to run with the wrong path argument.

### Testing Workflow (manual / live)
1. Build: `bun run build`
2. Copy output to test vault: `.obsidian/plugins/claude-code-terminal/`
3. Enable plugin in Obsidian settings
4. Copy the bearer token from the plugin's Authentication section
5. For Claude Code: Run `claude` in terminal and use `/ide` command (token is read from the lock file)
6. For Claude Desktop: Configure with the snippet generated in the Authentication settings section

## Configuration

### Claude Desktop Setup
The HTTP server requires a bearer token. Copy the snippet from the plugin's
Authentication section (it includes the live port and token), or build it by
hand using `mcp-remote`:
```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:22360/sse",
        "--header",
        "Authorization: Bearer <token-from-plugin-settings>"
      ]
    }
  }
}
```

### Plugin Settings
- Enable/disable WebSocket and HTTP servers independently
- Configure HTTP server port (default: 22360)
- View / copy / regenerate the bearer auth token
- Enable/disable terminal feature
- Real-time server status display

## Important Implementation Notes

- **Lock Files**: WebSocket server creates `[port].lock` files in the Claude config directory for auto-discovery. Lock file payload includes `authToken` so Claude Code can present it on the upgrade request:
  - Uses `CLAUDE_CONFIG_DIR` environment variable if set
  - Otherwise `$XDG_CONFIG_HOME/claude/ide/` or `~/.config/claude/ide/` (new default since Claude Code v1.0.30)
  - Falls back to `~/.claude/ide/` (legacy location)
- **Path Handling**: All paths normalized via `normalizePath()` utility
- **Security**:
  - File operations restricted to vault boundaries
  - Both transports require a bearer token; servers refuse to start without one
  - HTTP server binds to `127.0.0.1` only and rejects non-loopback `Origin` headers
  - The token is generated on first plugin load and persisted to plugin settings
- **Multi-Vault Support**: Each vault needs unique HTTP port (and gets its own auth token)
- **MCP Spec Version**: HTTP server uses 2024-11-05 spec for compatibility

## Release Process

### Patch Releases (Bug Fixes)
For patch releases, use the automated process:
1. Commit your changes with conventional commit messages
2. Run `npm version patch` (handles version bumping and tagging)
3. Run `bun run build` to create production build
4. Push with `git push && git push --tags`
5. Create GitHub release with `gh release create` including the three required files

See `docs/AUTOMATED_PATCH_RELEASE.md` for detailed steps.

### Minor/Major Releases
For minor and major releases, follow the manual process in `docs/RELEASE_CHECKLIST.md`:
1. Run `bun run version minor/major`
2. Test thoroughly with both Claude Code and Claude Desktop
3. Create GitHub release with version tag
4. Upload `manifest.json`, `main.js`, and `styles.css` as assets

## Coding Guidelines and Best Practices

- When refactoring, don't create files with a -refactored suffix, carry out the refactoring as a senior engineer would

## Memories

- be sure to read patch release process from CLAUDE.md prior to creating a new release