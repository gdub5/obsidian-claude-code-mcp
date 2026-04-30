import { App, TFile, getAllTags } from "obsidian";
import { McpReplyFunction } from "../mcp/types";
import { ToolDefinition, ToolImplementation } from "../shared/tool-registry";
import { normalizePath } from "../obsidian/utils";

// ──────────────────────────────────────────────────────────────────────
// search_vault safeguards
//
// Picked to keep one tool call from monopolizing Obsidian on a real
// (50k-note) vault. All four limits are independent — any one tripping
// stops the search early.

/** Hard ceiling on `max_results`, regardless of caller request. */
const SEARCH_MAX_RESULTS_HARD_CAP = 200;
/** Default when caller doesn't specify. */
const SEARCH_DEFAULT_RESULTS = 50;
/** Skip files larger than this. 1 MB excludes huge logs / dumps. */
const SEARCH_MAX_FILE_BYTES = 1_000_000;
/** Total budget for snippet bytes in the response, before MCP framing. */
const SEARCH_MAX_RESPONSE_BYTES = 256 * 1024;
/**
 * Hard cap on files actually opened by a single search. Independent of the
 * per-file size cap and the response budget — needed because a no-match (or
 * late-match) query would otherwise traverse the entire vault even when the
 * per-file and response caps never trip. 5,000 covers most real vaults; a
 * 50k-note vault gets a partial scan with a "scan budget hit" notice rather
 * than a 30-second freeze.
 */
const SEARCH_MAX_FILES_SCANNED = 5_000;
/**
 * Cumulative bytes read across all files in a single search call. Defense
 * in depth against a vault full of just-under-1MB markdown files (which
 * would still dump 5GB through the loop before the files-scanned cap
 * tripped). 50MB is generous for a full-text scan over text files.
 *
 * Note on time-based limits: deliberately not used. Wall-clock budgets are
 * non-deterministic in tests (CI timing flakes) and depend on system load
 * in production. Counting work directly gives the same protection without
 * those drawbacks.
 */
const SEARCH_MAX_BYTES_SCANNED = 50 * 1024 * 1024;

// ──────────────────────────────────────────────────────────────────────
// Tool definitions
//
// All metadata tools sit under category "workspace" — they operate on
// the vault's MetadataCache rather than file contents directly.

export const METADATA_TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "get_frontmatter",
		description:
			"Get the parsed YAML frontmatter of a note as JSON. Returns null if " +
			"the note has no frontmatter or doesn't exist.",
		category: "workspace",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the note (relative to vault root)",
				},
			},
		},
	},
	{
		name: "get_backlinks",
		description:
			"List the notes that link to the given note via wikilinks " +
			"([[target]]). Uses Obsidian's MetadataCache, so only resolved " +
			"links count.",
		category: "workspace",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the target note (relative to vault root)",
				},
			},
		},
	},
	{
		name: "get_outgoing_links",
		description:
			"List the notes that the given note links to. Returns both " +
			"resolved (target exists) and unresolved (target missing) links.",
		category: "workspace",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the source note (relative to vault root)",
				},
			},
		},
	},
	{
		name: "list_tags",
		description:
			"Enumerate every tag in the vault with a count of notes carrying it. " +
			"Includes both inline #tags and frontmatter `tags:` arrays. Tags are " +
			"returned with the leading `#`.",
		category: "workspace",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "find_by_tag",
		description:
			"Find all notes carrying a given tag. Supports nested tags: searching " +
			"`#project` matches `#project/april` etc. when `nested` is true (default).",
		category: "workspace",
		inputSchema: {
			type: "object",
			properties: {
				tag: {
					type: "string",
					description: "Tag to search for (with or without leading #)",
				},
				nested: {
					type: "boolean",
					description:
						"If true (default), nested tags also match: `#project` matches `#project/april`. If false, exact match only.",
				},
			},
		},
	},
	{
		name: "search_vault",
		description:
			"Full-text search across all notes in the vault. Returns matching " +
			"file paths with line numbers and snippets. Case-insensitive by default.",
		category: "workspace",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Text to search for",
				},
				max_results: {
					type: "integer",
					description:
						"Cap on returned matches (default 50). Lower this for narrower context windows.",
				},
				case_sensitive: {
					type: "boolean",
					description: "If true, match case exactly. Default false.",
				},
			},
		},
	},
];

// ──────────────────────────────────────────────────────────────────────
// Implementation

export class MetadataTools {
	constructor(private app: App) {}

	createImplementations(): ToolImplementation[] {
		return [
			{
				name: "get_frontmatter",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const file = this.resolveFile(args, reply);
						if (!file) return;
						const cache = this.app.metadataCache.getFileCache(file);
						const fm = cache?.frontmatter ?? null;
						return reply({
							result: {
								content: [
									{
										type: "text",
										text: JSON.stringify(fm, null, 2),
									},
								],
							},
						});
					} catch (error: any) {
						reply({
							error: {
								code: -32603,
								message: `failed to get frontmatter: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "get_backlinks",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const file = this.resolveFile(args, reply);
						if (!file) return;
						const target = file.path;
						const resolved =
							(this.app.metadataCache as any).resolvedLinks ?? {};

						const sources: string[] = [];
						for (const [source, targets] of Object.entries(resolved)) {
							if ((targets as Record<string, number>)[target]) {
								sources.push(source);
							}
						}
						sources.sort();

						return reply({
							result: {
								content: [
									{
										type: "text",
										text:
											sources.length > 0
												? `Backlinks for ${target} (${sources.length}):\n${sources.join("\n")}`
												: `No backlinks for ${target}.`,
									},
								],
							},
						});
					} catch (error: any) {
						reply({
							error: {
								code: -32603,
								message: `failed to get backlinks: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "get_outgoing_links",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const file = this.resolveFile(args, reply);
						if (!file) return;
						const source = file.path;
						const resolved =
							(this.app.metadataCache as any).resolvedLinks?.[source] ??
							{};
						const unresolved =
							(this.app.metadataCache as any).unresolvedLinks?.[source] ??
							{};

						const resolvedList = Object.keys(resolved).sort();
						const unresolvedList = Object.keys(unresolved).sort();

						const lines: string[] = [];
						lines.push(
							`Outgoing links from ${source} (${resolvedList.length} resolved, ${unresolvedList.length} unresolved):`
						);
						if (resolvedList.length) {
							lines.push("Resolved:");
							for (const r of resolvedList) lines.push(`  ${r}`);
						}
						if (unresolvedList.length) {
							lines.push("Unresolved:");
							for (const u of unresolvedList) lines.push(`  ${u}`);
						}
						if (!resolvedList.length && !unresolvedList.length) {
							lines.push("(no links)");
						}

						return reply({
							result: {
								content: [
									{
										type: "text",
										text: lines.join("\n"),
									},
								],
							},
						});
					} catch (error: any) {
						reply({
							error: {
								code: -32603,
								message: `failed to get outgoing links: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "list_tags",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const counts = new Map<string, number>();
						for (const file of this.app.vault.getFiles()) {
							const cache = this.app.metadataCache.getFileCache(file);
							if (!cache) continue;
							const tags = getAllTags(cache);
							if (!tags) continue;
							// Dedupe per-file so counts are notes-with-tag, not occurrences.
							const unique = new Set(tags);
							for (const t of unique) {
								counts.set(t, (counts.get(t) ?? 0) + 1);
							}
						}

						// Sort by count desc, then by name for stability.
						const sorted = Array.from(counts.entries()).sort(
							(a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
						);

						const text = sorted.length
							? `Tags in vault (${sorted.length}):\n` +
								sorted.map(([t, n]) => `  ${t} (${n})`).join("\n")
							: "No tags found in vault.";

						return reply({
							result: {
								content: [{ type: "text", text }],
							},
						});
					} catch (error: any) {
						reply({
							error: {
								code: -32603,
								message: `failed to list tags: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "find_by_tag",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { tag, nested } = args || {};
						if (!tag || typeof tag !== "string") {
							return reply({
								error: {
									code: -32602,
									message: "tag parameter is required and must be a string",
								},
							});
						}

						const wantNested = nested !== false; // default true
						const target = tag.startsWith("#") ? tag : `#${tag}`;
						const targetWithSlash = `${target}/`;

						const matches: string[] = [];
						for (const file of this.app.vault.getFiles()) {
							const cache = this.app.metadataCache.getFileCache(file);
							if (!cache) continue;
							const tags = getAllTags(cache);
							if (!tags) continue;
							const hit = tags.some(
								(t) =>
									t === target ||
									(wantNested && t.startsWith(targetWithSlash))
							);
							if (hit) matches.push(file.path);
						}
						matches.sort();

						const text = matches.length
							? `Files tagged ${target}${wantNested ? " (incl. nested)" : ""} — ${matches.length}:\n${matches.join("\n")}`
							: `No files tagged ${target}.`;

						return reply({
							result: {
								content: [{ type: "text", text }],
							},
						});
					} catch (error: any) {
						reply({
							error: {
								code: -32603,
								message: `failed to find by tag: ${error.message}`,
							},
						});
					}
				},
			},
			{
				name: "search_vault",
				handler: async (args: any, reply: McpReplyFunction) => {
					try {
						const { query, max_results, case_sensitive } = args || {};
						if (!query || typeof query !== "string") {
							return reply({
								error: {
									code: -32602,
									message: "query parameter is required and must be a string",
								},
							});
						}
						// ── safeguards (PR B hardening) ──────────────────────
						// Codex review flagged the original implementation as
						// able to freeze the host on a real vault: unbounded
						// max_results, scans every file (including binaries),
						// reads whole content, builds one big response. The
						// four limits below address that.
						const cap = Math.min(
							typeof max_results === "number" && max_results > 0
								? max_results
								: SEARCH_DEFAULT_RESULTS,
							SEARCH_MAX_RESULTS_HARD_CAP
						);
						const cmp = case_sensitive ? query : query.toLowerCase();

						const hits: Array<{ path: string; line: number; snippet: string }> = [];
						let bytesUsed = 0;
						let truncatedByResponseBudget = false;
						let truncatedByScanBudget: false | "files" | "bytes" = false;
						let filesScanned = 0;
						let bytesScanned = 0;

						// Markdown-only — skip PDFs / images / audio / canvas etc.
						// Falls back to getFiles() if the API is missing (older
						// Obsidian or partial mocks).
						const files =
							typeof (this.app.vault as any).getMarkdownFiles === "function"
								? (this.app.vault as any).getMarkdownFiles()
								: this.app.vault.getFiles().filter((f: any) => f.extension === "md");

						outer: for (const file of files) {
							if (hits.length >= cap) break;

							// Scan budgets — these fire even on a no-match
							// query, where neither the result cap nor the
							// response-byte budget can trip. Without these
							// a 50k-note vault would still get fully traversed.
							if (filesScanned >= SEARCH_MAX_FILES_SCANNED) {
								truncatedByScanBudget = "files";
								break;
							}
							if (bytesScanned >= SEARCH_MAX_BYTES_SCANNED) {
								truncatedByScanBudget = "bytes";
								break;
							}

							// Skip files larger than the per-file byte budget.
							// `stat.size` is set by Obsidian and our mock; treat
							// missing as 0 (don't penalize unknown-size files).
							const size = (file as any).stat?.size ?? 0;
							if (size > SEARCH_MAX_FILE_BYTES) continue;

							let content: string;
							try {
								// Prefer cachedRead — it's the canonical
								// "I'm only reading" API and uses Obsidian's
								// in-memory buffer when the file is already open.
								if (typeof (this.app.vault as any).cachedRead === "function") {
									content = await (this.app.vault as any).cachedRead(file);
								} else {
									content = await this.app.vault.adapter.read(file.path);
								}
							} catch {
								filesScanned++; // count the attempt against the budget
								continue;
							}

							// Defense in depth: even if stat lied, don't process
							// huge content.
							if (content.length > SEARCH_MAX_FILE_BYTES) {
								filesScanned++;
								continue;
							}

							filesScanned++;
							bytesScanned += content.length;

							const lines = content.split("\n");
							for (let i = 0; i < lines.length; i++) {
								if (hits.length >= cap) break outer;
								const haystack = case_sensitive
									? lines[i]
									: lines[i].toLowerCase();
								if (!haystack.includes(cmp)) continue;

								const snippet = trimSnippet(lines[i]);
								// Approximate the bytes this hit will contribute
								// to the response (path + line + snippet + " : ").
								const approxLineBytes =
									snippet.length + file.path.length + 16;
								if (bytesUsed + approxLineBytes > SEARCH_MAX_RESPONSE_BYTES) {
									truncatedByResponseBudget = true;
									break outer;
								}
								hits.push({
									path: file.path,
									line: i + 1,
									snippet,
								});
								bytesUsed += approxLineBytes;
							}
						}

						const cappedByCount = hits.length >= cap;
						const truncationNote = truncatedByScanBudget === "files"
							? `, search incomplete — scan budget hit (${SEARCH_MAX_FILES_SCANNED} files scanned)`
							: truncatedByScanBudget === "bytes"
								? `, search incomplete — scan budget hit (${Math.round(SEARCH_MAX_BYTES_SCANNED / (1024 * 1024))}MB read)`
								: truncatedByResponseBudget
									? `, truncated at ${SEARCH_MAX_RESPONSE_BYTES} byte response budget`
									: cappedByCount
										? `, capped at ${cap} results`
										: "";

						// If the scan budget tripped on a no-match query, the
						// caller MUST know the result is incomplete — otherwise
						// they'll treat it as "definitely no match in vault".
						const text = hits.length
							? `Search results for "${query}" (${hits.length}${truncationNote}):\n` +
								hits
									.map((h) => `${h.path}:${h.line}: ${h.snippet}`)
									.join("\n")
							: truncatedByScanBudget
								? `No matches found for "${query}" yet${truncationNote}. The scan was halted before the entire vault was searched — narrow the query to be sure.`
								: `No matches for "${query}".`;

						return reply({
							result: {
								content: [{ type: "text", text }],
							},
						});
					} catch (error: any) {
						reply({
							error: {
								code: -32603,
								message: `failed to search vault: ${error.message}`,
							},
						});
					}
				},
			},
		];
	}

	/**
	 * Validate the `path` argument and look the file up in the vault.
	 * Replies with a JSON-RPC error and returns null on any problem.
	 */
	private resolveFile(args: any, reply: McpReplyFunction): TFile | null {
		const { path } = args || {};
		if (!path || typeof path !== "string") {
			reply({
				error: { code: -32602, message: "invalid path parameter" },
			});
			return null;
		}

		const normalized = normalizePath(path);
		if (!normalized) {
			reply({
				error: { code: -32602, message: "invalid file path" },
			});
			return null;
		}

		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!file || !(file instanceof TFile)) {
			reply({
				error: {
					code: -32603,
					message: `File not found: ${normalized}`,
				},
			});
			return null;
		}

		return file;
	}
}

function trimSnippet(line: string, max = 200): string {
	const trimmed = line.trim();
	return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
}
