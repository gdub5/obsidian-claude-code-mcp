# Changelog

## v1.1.11 — 2026-04-30 (PR C: Streamable HTTP transport)

Adds a new `/mcp` endpoint implementing the Streamable HTTP transport
introduced in MCP spec `2025-03-26` (refined through `2025-06-18` and
later). Existing `/sse` + `/messages` clients keep working unchanged —
this is purely additive.

### What's new

- **`POST /mcp`** — single-endpoint JSON-RPC over HTTP. Body is one
  JSON-RPC message or an array. Responses come back inline as
  `application/json`; notifications-only batches return `202 Accepted`
  with no body.
- **Session lifecycle.** `initialize` mints a session id; the server
  returns it in the `Mcp-Session-Id` response header. Subsequent
  requests must echo it back as a header. Unknown / missing session ids
  are rejected with `404` / `400` respectively.
- **`DELETE /mcp`** — explicit session termination. Clients can release
  server-side state cleanly when they're done.
- **`GET /mcp`** — declined with `405 Method Not Allowed` (server-
  initiated streams aren't implemented yet; broadcasts still go over
  legacy `/sse` for now). The `Allow` response header advertises which
  methods are supported, so a probing client gets an honest answer.
- **CORS** updated: allows `Mcp-Session-Id` and `MCP-Protocol-Version`
  request headers, and exposes `Mcp-Session-Id` to readers via
  `Access-Control-Expose-Headers`.

### What's intentionally out of scope

- **Streaming responses** (`Content-Type: text/event-stream` on POST
  responses). None of our handlers actually stream output, so we
  always return JSON. A client that requests *only* `text/event-stream`
  via `Accept` gets a clean `406` rather than a misleading hang.
- **Server-initiated streams** (`GET /mcp`). Required by some clients
  for progress notifications and server-driven prompts; not needed by
  any of the current tools. Will land if a tool needs it.
- **Newer MCP features** (elicitation, structured tool output via
  `outputSchema`/`structuredContent`, `MCP-Protocol-Version` validation
  beyond pass-through). The plugin still implements the `2024-11-05`
  protocol — only the *transport* is new.

### Reliability

- **10-second handler timeout** on every dispatched request. If a tool
  handler never replies, the client gets a JSON-RPC `-32603` after 10s
  rather than an HTTP request that hangs forever.
- **Origin check + bearer-token auth** apply unchanged. A request to
  `/mcp` goes through the same gate as `/sse` and `/messages`.

### Tests

- **17 new unit tests** in `tests/mcp/http-server.test.ts` covering:
  auth (no token / wrong token), session lifecycle (mint / reject
  missing / reject unknown / reuse), body shapes (single / array /
  notification-only / parse-error / empty-batch), Accept-header
  negotiation, method routing (GET → 405), and DELETE.
- **Integration stress harness** extended with a dedicated `/mcp`
  block that opens a parallel session over the modern transport and
  cross-checks tool count and dispatch behavior against the legacy
  `/sse` path.
- Total tests now **147** (was 130 in v1.1.10).

## v1.1.10 — 2026-04-30 (PR B: MetadataCache integration)

Six new tools backed by Obsidian's MetadataCache. Shifts the plugin from a
pure file-CRUD layer to a knowledge-graph-aware one — Claude can now reason
about links, tags, and frontmatter without manually re-parsing notes.

### New tools

- **`get_frontmatter(path)`** — returns parsed YAML frontmatter as JSON, or
  null. No need to re-parse from raw note text.
- **`get_backlinks(path)`** — every note that wikilinks to the target.
  Reads from `app.metadataCache.resolvedLinks`, so only resolved links count.
- **`get_outgoing_links(path)`** — every note the source links to, split
  into resolved and unresolved.
- **`list_tags()`** — every tag in the vault with a per-note count
  (deduped within each note). Merges inline `#tags` and frontmatter
  `tags:` arrays via `getAllTags()`.
- **`find_by_tag(tag, nested?)`** — files carrying a given tag. Defaults to
  nested matching: `#project` matches `#project/april` etc. Pass
  `nested: false` for exact-match-only.
- **`search_vault(query, max_results?, case_sensitive?)`** — full-text
  scan with `path:line: snippet` output. Case-insensitive by default.
  Hardened against pathological inputs (see Safeguards below).

### `search_vault` safeguards (post-Codex-review hardening)

The first cut of `search_vault` was structurally unbounded. Three
successive Codex adversarial passes each caught a real issue that
self-review missed; all three fixes are folded in here.

Six limits now apply:

1. **`max_results` is clamped** to a hard ceiling of 200 regardless of
   what the caller asks for. Default stays 50.
2. **Markdown-only.** Uses `vault.getMarkdownFiles()` instead of
   `getFiles()`, so PDFs / images / canvas / audio attachments are never
   scanned.
3. **Per-file byte cap.** Files reporting `stat.size > 1 MB` are skipped;
   defense in depth checks content length again after read.
4. **Response byte budget.** Total snippet bytes are tracked as hits
   accumulate; once over 256 KB the loop short-circuits and the response
   labels itself "truncated at the byte budget".
5. **Files-scanned budget.** Hard cap of 5,000 markdown files visited
   per call. The first four caps all bound *output*; the second adversarial
   pass (correctly) noted that a no-match query would still traverse the
   whole vault. Files-scanned bounds *work*, fires regardless of result
   count, and surfaces "search incomplete" in the response — the caller
   can't mistake a halted scan for a complete no-match answer.
6. **Bytes-scanned budget.** Hard cap of 50 MB cumulative read across
   all files in a single call. Defense in depth against a vault full of
   just-under-1 MB markdown files (5,000 such files would otherwise
   stream ~5 GB through the loop before the file-count cap tripped).
   Counted in **actual UTF-8 bytes** (`stat.size` when available, falling
   back to `Buffer.byteLength(content, 'utf8')`) rather than UTF-16 code
   units — without this, a CJK or emoji-heavy vault would have blown
   past the advertised cap by 2-3x because `string.length` undercounts
   multibyte content. Includes a pre-read short-circuit using `stat.size`
   so we can halt before paying the cost of `cachedRead` on the file
   that would tip us over.

No wall-clock budget. Time-based limits introduce CI flakiness and
depend on system load; counting work directly is deterministic.

Switched from `vault.adapter.read(path)` to `vault.cachedRead(file)` —
the canonical read-only API; uses Obsidian's in-memory buffer when the
file is open.

Eight new unit tests pin each safeguard: hard-cap clamping, file-size
skip, non-markdown filter, byte-budget truncation, files-scanned scan
budget, bytes-scanned scan budget, multibyte-content byte accounting
(CJK content trips the cap based on real bytes, not code units), and a
regression guard that small no-match queries still produce clean "no
matches" output (not a false "search incomplete" notice).

Total tool count is now **13** (was 7). All metadata tools are registered
to both transports (WS + HTTP).

### Tests

- **`tests/tools/metadata-tools.test.ts`** — 28 unit tests covering all
  six tools, including edge cases (empty vault, dedup-per-file in
  list_tags, nested vs exact matching in find_by_tag, case sensitivity
  and max_results capping in search_vault, snippet trimming for long lines).
- Obsidian mock extended with realistic MetadataCache: `getFileCache`,
  `resolvedLinks`/`unresolvedLinks`, plus `__seedLinks` and
  `__setFileCache` test helpers. `getAllTags()` exported as a top-level
  function matching real Obsidian.
- **Integration stress harness extended** with 8 assertions against the
  fixture vault's pinned link topology and tag distribution. The fixtures
  in `test-fixtures/vault/` were designed for exactly this — every
  expected backlink, outgoing link, and tag membership is documented in
  `test-fixtures/README.md` and pinned in the harness.

### Internal

- `dual-server.ts` registration loop refactored: `registerToBothRegistries()`
  pairs definitions to implementations by name (not position) so future
  tool families can drop in without copy-pasting the loop.

## v1.1.9 — 2026-04-30

First release of the gdub5 fork. Three coordinated PRs landed together:
spec hygiene + cleanup, bearer-token auth, and a tool-handler test scaffold
with bug fixes surfaced by it.

### MCP spec hygiene (against 2024-11-05)

- **Fixed: notifications no longer get error-replied.** JSON-RPC notifications
  (no `id` field — `notifications/initialized`, `notifications/cancelled`, etc.)
  were being sent `Method not found` responses. They are now silently accepted,
  per JSON-RPC 2.0.
- **Fixed: `roots` was advertised as a server capability.** It's a *client*
  capability per spec. Removed from the `initialize` response.
- **Fixed: empty `prompts` and `resources` capabilities advertised but not
  implemented.** Removed from the `initialize` response. Will be re-added
  when the features land.
- **Fixed: `serverInfo.version` hardcoded to `"1.0.0"`.** Now sourced from the
  plugin manifest at runtime.
- **Fixed: unknown tool returned a fake-success result with the error in the
  text field.** Now returns a proper `-32602` JSON-RPC error.
- **Fixed: `ping` returned the string `"pong"`.** Spec says return an empty
  result object — corrected.
- **Fixed: path-validation errors used `-32603` (internal error).** They are
  parameter validation failures and now return `-32602` (invalid params)
  consistently across `view`, `create`, `str_replace`, `insert`.

### Bearer-token authentication (BREAKING)

Both transports now require a per-vault bearer token. The token is
auto-generated on first plugin load and persisted to plugin settings.
The HTTP server refuses to start without one.

- **WebSocket (Claude Code IDE):** token is written into the discovery lock
  file's `authToken` field. Claude Code reads it and sends it on the upgrade
  request as `x-claude-code-ide-authorization`. The WS server validates via
  `ws.WebSocketServer.verifyClient` — bad token → 401 Unauthorized at upgrade.
- **HTTP/SSE (Claude Desktop / mcp-remote):** server validates
  `Authorization: Bearer <token>` on both `/messages` POST and `/sse` GET.
  EventSource clients that can't set headers may pass `?token=<token>` on the
  SSE GET as a fallback. Bad/missing token → 401.
- **Origin check:** `validateOrigin` now actually validates. Loopback origins
  (`localhost`, `127.0.0.1`, `[::1]`) and missing-origin (native clients) are
  allowed; everything else returns 403.
- **CORS:** `Access-Control-Allow-Origin` no longer reflects `*`. Pinned to
  `http://localhost`.
- **Settings UI:** new Authentication section with the token in plain text
  (no security gain from masking when it's also in the config snippet),
  Copy and Regenerate buttons (regenerate confirms before disconnecting
  active clients), and a ready-to-paste config snippet for Claude Desktop /
  mcp-remote with the live port and token already filled in.

**Migration:** existing users will be upgraded automatically on plugin reload.
A token is minted on first load post-upgrade. Existing Claude Desktop /
mcp-remote configs must be updated to include the `--header` flag — see the
snippet shown in the Authentication settings section.

### Tool-handler test scaffold + bug fixes

- **Added Vitest unit-test suite** covering utils, tool registry, MCP
  handlers, auth helpers, settings, HTTP server, and WebSocket server.
- **Added `tests/tools/general-tools.test.ts`** with 30 tests covering all
  seven tools — first unit-test coverage of tool implementations.
- **Added `tests/integration/stress.mjs`** — end-to-end harness that drives
  the live plugin over HTTP/SSE. Exercises the auth gate, framing,
  notifications, parallel reads, the full create/view/str_replace/insert
  flow, edge-case paths (spaces, unicode, nested), and negative tests
  (path traversal, unknown tools).
- **Fixed: `create` did not auto-create parent folders.** Calls
  `vault.createFolder(parent)` then `vault.create()` (was `adapter.write()`
  which surfaced ENOENT race conditions when mixed with vault-layer folder
  creation — staying in the `vault.*` API avoids the class).
- **Fixed: `view` of a directory did not surface subfolder names.** Listing
  `notes/` previously showed only direct files; now also lists subfolder
  entries with a trailing `/`.
- **Removed the legacy direct-method handlers** (`readFile`, `writeFile`,
  `getOpenFiles`, `listFiles`, `getCurrentFile`, `getWorkspaceInfo`). All
  tools are now reached via standard MCP `tools/call`.
- **Removed dead modules:** `src/tools/file-tools.ts`,
  `src/tools/workspace-tools.ts`, `src/tools/mcp-only-tools.ts`, plus the
  stale manual test scripts at the repo root.

### Test vault + dev workflow

- **Test vault fixtures** at `test-fixtures/vault/` — committed canonical
  content with a deliberate link topology, controlled tag distribution, and
  edge-case files (spaces in name, unicode, empty file, deeply nested).
- **`scripts/setup-test-vault.sh`** — idempotent script that wipes a target
  Obsidian vault and reseeds it from fixtures. Refuses to wipe directories
  it doesn't recognize as a test vault.
- **`bun run test`, `bun run test:watch`, `bun run test:coverage`,
  `bun run test:integration`, `bun run test-vault:setup`** — npm scripts for
  the new test surface.

### Build / packaging

- **Build timestamp injected** by esbuild via `define.__BUILD_STAMP__`.
- **Settings shows version + build stamp** at the top of the Authentication
  section (`v1.1.9 · built 2026-04-30T...`). Designed to make "wrong bundle
  loaded" failures visible at a glance — saved real debugging time.
- **`install.sh`** now accepts a target path argument or `--vault VAULT_PATH`
  flag, falls back to `OBSIDIAN_PLUGIN_PATH` env var, then to a hardcoded
  default. Reads plugin id from `manifest.json` so a future rename stays in
  sync. Warns if the target path doesn't look like an Obsidian plugin
  directory.
- **Manifest:** author updated to `gdub5`, authorUrl to the fork's GitHub.
  Plugin id (`claude-code-mcp`) and display name (`Claude Code MCP`)
  unchanged.
