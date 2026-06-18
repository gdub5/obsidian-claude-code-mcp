# Community Plugin Submission Guide

This document provides step-by-step instructions for submitting the Claude Code Editor & MCP plugin to the Obsidian Community Plugin Directory.

## Plugin Information

**Plugin Entry for community-plugins.json:**

```json
{
	"id": "claude-code-mcp",
	"name": "Claude Code MCP",
	"author": "gdub5",
	"description": "Connect Claude Code and other AI tools to your notes using Model Context Protocol (MCP).",
	"repo": "gdub5/obsidian-claude-code-mcp"
}
```

## Submission Process

### 1. Prepare Repository

-   [x] Repository is public: `https://github.com/gdub5/obsidian-claude-code-mcp`
-   [x] All required files are present and valid
-   [x] Latest release is created with proper artifacts
-   [x] Documentation is comprehensive and user-friendly

### 2. Create Release

Before submitting, ensure you have a proper GitHub release:

```bash
# Update version (if needed) — npm runs the `version` script in package.json,
# which syncs manifest.json + versions.json via version-bump.mjs
npm version patch

# Build the plugin
bun run build

# Create GitHub release with the version number as the tag (no 'v' prefix), e.g. 1.1.13
# Upload these files as binary attachments:
# - manifest.json
# - main.js
# - styles.css
```

### 3. Fork obsidian-releases Repository

1. Go to https://github.com/obsidianmd/obsidian-releases
2. Click "Fork" to create your own copy
3. Clone your fork locally

### 4. Add Plugin Entry

1. Open `community-plugins.json` in your fork
2. Add the plugin entry to the **end** of the JSON array:

```json
{
	"id": "claude-code-mcp",
	"name": "Claude Code MCP",
	"author": "gdub5",
	"description": "Connect Claude Code and other AI tools to your notes using Model Context Protocol (MCP).",
	"repo": "gdub5/obsidian-claude-code-mcp"
}
```

3. Validate JSON syntax:

```bash
jq . community-plugins.json
```

### 5. Submit Pull Request

1. Create a new branch: `git checkout -b add-claude-code-mcp`
2. Commit changes: `git commit -m "Add Claude Code Editor & MCP plugin"`
3. Push to your fork: `git push origin add-claude-code-mcp`
4. Open pull request on the main obsidian-releases repository

### 6. Pull Request Details

**Title:** `Add Claude Code MCP plugin`

**Description:**

```markdown
# Claude Code MCP Plugin Submission

## Plugin Information

-   **Name:** Claude Code MCP
-   **Author:** gdub5
-   **Repository:** https://github.com/gdub5/obsidian-claude-code-mcp
-   **Latest Release:** 1.1.13

## Description

This plugin implements an MCP (Model Context Protocol) server to enable Claude Code and Claude Desktop integration with Obsidian vaults. It provides AI-powered assistance with direct access to your notes and files.

## Key Features

-   Multi-transport MCP server (WebSocket, modern Streamable HTTP at `/mcp`, and legacy HTTP/SSE at `/sse`)
-   Auto-discovery for Claude Code CLI
-   File operations through MCP protocol
-   Workspace context and vault structure access
-   Multiple client support (Claude Code + Claude Desktop)
-   Configurable ports for multi-vault setups

## Technical Details

-   **Desktop Only:** Yes (requires WebSocket server capabilities)
-   **Dependencies:** All bundled, no external runtime dependencies
-   **Min Obsidian Version:** 1.0.0
-   **File Size:** ~720KB (bundled)

## Testing

-   [x] Plugin loads and functions correctly in Obsidian
-   [x] All MCP tools work as expected
-   [x] WebSocket and HTTP servers start successfully
-   [x] Claude Code and Claude Desktop integration tested
-   [x] Error handling works gracefully
-   [x] Compatible with multiple Obsidian versions

## Compliance

-   [x] All required files present (manifest.json, main.js, styles.css)
-   [x] JSON files validated
-   [x] Documentation comprehensive
-   [x] No hardcoded secrets or security issues
-   [x] Follows Obsidian plugin guidelines

## Repository Quality

-   [x] Public repository with clear README
-   [x] Proper versioning and release process
-   [x] ISC licensed
-   [x] Clean codebase with TypeScript
-   [x] No malicious code or dependencies

This plugin enables powerful AI-assisted note-taking by connecting Obsidian directly to Claude's advanced capabilities through the standardized MCP protocol.
```

### 7. Post-Submission Checklist

-   [ ] Monitor PR for reviewer comments
-   [ ] Respond to feedback promptly
-   [ ] Make requested changes if needed
-   [ ] Update documentation if requested
-   [ ] Be available for questions about implementation

## Expected Timeline

-   **Initial Review:** 1-2 weeks
-   **Feedback/Revisions:** Varies based on required changes
-   **Final Approval:** After all requirements met
-   **Directory Listing:** Within 24 hours of merge

## Common Review Points

Based on Obsidian's review process, expect potential questions about:

1. **Security:** Network access, file operations, bundled dependencies
2. **Performance:** Bundle size, startup impact, memory usage
3. **User Experience:** Error handling, documentation clarity
4. **Compatibility:** Cross-platform testing, Obsidian version support
5. **Technical Implementation:** MCP protocol usage, WebSocket security

## Repository Quality Indicators

The plugin repository demonstrates:

-   **Professional Development:** TypeScript, ESLint, proper build system
-   **Good Documentation:** Comprehensive README, technical docs, examples
-   **Active Maintenance:** Recent commits, version management
-   **Community Focus:** Clear installation instructions, troubleshooting
-   **Security Conscious:** No hardcoded secrets, proper error handling

## Notes

-   The plugin ID `claude-code-mcp` differs from repository name `obsidian-claude-code-mcp` - this is intentional and documented
-   Plugin requires desktop-only features (WebSocket servers) and is properly marked
-   All dependencies are bundled - users don't need to install additional software
-   Supports multiple vault configurations through port management
