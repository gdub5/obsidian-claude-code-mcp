import { App, TFile } from "obsidian";
import { McpReplyFunction } from "../mcp/types";
import { ToolDefinition, ToolImplementation } from "../shared/tool-registry";
import { normalizePath } from "../obsidian/utils";

// ──────────────────────────────────────────────────────────────────────
// Community-plugin gateway tools
//
// Wraps the public APIs of three popular Obsidian community plugins that
// the user has installed:
//
//   - omnisearch         → ranked full-text search across markdown / PDF /
//                          OCR'd images / Office docs / CSV
//   - text-extractor     → extract raw text from non-markdown formats
//   - dataview           → DQL-style structured queries against the vault
//
// Each tool is registered ONLY when its underlying plugin is installed
// and enabled. Vaults without a given plugin won't see its tool in the
// `tools/list` response — preferable to listing tools that always fail,
// because Claude can't reason about a non-existent capability.
//
// All three tools are read-only and closed-world: they don't mutate the
// vault and don't reach beyond it. Annotations are set accordingly.

/** Plugin IDs we wrap. Used for presence checks AND tool registration. */
const PLUGIN_OMNISEARCH = "omnisearch";
const PLUGIN_TEXT_EXTRACTOR = "text-extractor";
const PLUGIN_DATAVIEW = "dataview";

/**
 * Cap the bytes of extracted text returned to the client. Same shape
 * as the search_vault response budget — protects against pathological
 * inputs (a 50MB PDF would otherwise bloat one MCP message into the
 * megabyte range).
 */
const EXTRACT_TEXT_MAX_BYTES = 256 * 1024;

/** Hard cap on omnisearch results returned. The plugin itself caps at 50. */
const OMNISEARCH_HARD_CAP = 50;
const OMNISEARCH_DEFAULT_RESULTS = 20;

/**
 * Pull a community plugin's `.api` object if the plugin is installed +
 * enabled. Returns null otherwise. The `as any` cast is necessary
 * because the public Obsidian API surface (the `App` type) doesn't
 * declare `plugins` — that namespace is technically internal but stable
 * across versions and used by every plugin-development guide.
 */
function getPluginApi(app: App, id: string): any {
	const reg = (app as any).plugins;
	if (!reg || !reg.plugins) return null;
	const plugin = reg.plugins[id];
	if (!plugin) return null;
	return plugin.api ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// Definitions
//
// Each definition is exported individually so dual-server.ts can pair
// them with implementations by name; the PluginTools class filters
// the list it returns based on which plugins are actually present.

const OMNISEARCH_DEF: ToolDefinition = {
	name: "omnisearch",
	description:
		"Ranked full-text search across the vault using the Omnisearch plugin. " +
		"Indexes markdown AND non-markdown formats (PDFs, OCR'd images, " +
		"Office documents, CSVs). Returns results sorted by relevance with " +
		"matched word lists. Prefer this over `search_vault` for relevance " +
		"queries or whenever PDFs / images / spreadsheets might contain the " +
		"answer; use `search_vault` when you need every literal occurrence " +
		"of a substring on markdown only.",
	category: "workspace",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"Search query. Supports basic boolean syntax (foo bar, " +
					"foo OR bar, foo -bar) per Omnisearch's query language.",
			},
			max_results: {
				type: "integer",
				description:
					"Maximum results to return (default 20, hard cap 50 per " +
					"the underlying Omnisearch index).",
			},
		},
	},
	annotations: {
		title: "Omnisearch (ranked, multi-format)",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
};

const EXTRACT_TEXT_DEF: ToolDefinition = {
	name: "extract_text",
	description:
		"Extract plain text from a non-markdown file (PDF, image via OCR, " +
		"Word/Excel/PowerPoint document) using the Text Extractor plugin. " +
		"Useful for asking 'what does this contract say' or 'summarize the " +
		"sponsor manual' without the user opening the file. For markdown " +
		"files, use `view` instead — this tool will refuse them.",
	category: "file",
	inputSchema: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Path to the file (relative to vault root). Must be a " +
					"format the Text Extractor plugin can handle.",
			},
		},
	},
	annotations: {
		title: "Extract Text from PDF / Image / Office Doc",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
};

const DATAVIEW_QUERY_DEF: ToolDefinition = {
	name: "dataview_query",
	description:
		"Run a Dataview Query Language (DQL) query against the vault. " +
		"DQL has four top-level statements: TABLE, LIST, TASK, CALENDAR. " +
		"Tag filters use `file.tags` (e.g. `WHERE contains(file.tags, " +
		"\"#confirmed\")`); folder filters use `FROM \"path/to/folder\"`. " +
		"Returns formatted markdown (table / list / task list). Useful for " +
		"questions like 'list all confirmed events sorted by date with " +
		"venue' that would otherwise require many file reads. Read-only.",
	category: "workspace",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"A complete DQL query starting with TABLE, LIST, TASK, " +
					"or CALENDAR.",
			},
		},
	},
	annotations: {
		title: "Run Dataview DQL Query",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
};

// ──────────────────────────────────────────────────────────────────────
// Implementation

export class PluginTools {
	constructor(private app: App) {}

	/**
	 * Tool definitions for plugins that are installed + enabled.
	 * dual-server.ts pairs this with createImplementations() by name,
	 * so both lists must be consistent — they are because they share
	 * the same hasPlugin() gating.
	 */
	getDefinitions(): ToolDefinition[] {
		const defs: ToolDefinition[] = [];
		if (this.hasPlugin(PLUGIN_OMNISEARCH)) defs.push(OMNISEARCH_DEF);
		if (this.hasPlugin(PLUGIN_TEXT_EXTRACTOR)) defs.push(EXTRACT_TEXT_DEF);
		if (this.hasPlugin(PLUGIN_DATAVIEW)) defs.push(DATAVIEW_QUERY_DEF);
		return defs;
	}

	createImplementations(): ToolImplementation[] {
		const impls: ToolImplementation[] = [];
		if (this.hasPlugin(PLUGIN_OMNISEARCH)) impls.push(this.omnisearchImpl());
		if (this.hasPlugin(PLUGIN_TEXT_EXTRACTOR)) impls.push(this.extractTextImpl());
		if (this.hasPlugin(PLUGIN_DATAVIEW)) impls.push(this.dataviewImpl());
		return impls;
	}

	private hasPlugin(id: string): boolean {
		return getPluginApi(this.app, id) !== null;
	}

	// ── omnisearch ──────────────────────────────────────────────────────

	private omnisearchImpl(): ToolImplementation {
		return {
			name: "omnisearch",
			handler: async (args: any, reply: McpReplyFunction) => {
				try {
					const { query, max_results } = args || {};
					if (!query || typeof query !== "string") {
						return reply({
							error: {
								code: -32602,
								message: "query parameter is required and must be a string",
							},
						});
					}
					const cap = Math.min(
						typeof max_results === "number" && max_results > 0
							? max_results
							: OMNISEARCH_DEFAULT_RESULTS,
						OMNISEARCH_HARD_CAP
					);

					const api = getPluginApi(this.app, PLUGIN_OMNISEARCH);
					if (!api || typeof api.search !== "function") {
						return reply({
							error: {
								code: -32603,
								message:
									"Omnisearch plugin is not available (was it disabled after server start?)",
							},
						});
					}

					const results = await api.search(query);
					const trimmed = Array.isArray(results) ? results.slice(0, cap) : [];
					const text = formatOmnisearchResults(query, trimmed, results.length);
					return reply({
						result: { content: [{ type: "text", text }] },
					});
				} catch (error: any) {
					reply({
						error: {
							code: -32603,
							message: `omnisearch failed: ${error?.message ?? error}`,
						},
					});
				}
			},
		};
	}

	// ── extract_text ───────────────────────────────────────────────────

	private extractTextImpl(): ToolImplementation {
		return {
			name: "extract_text",
			handler: async (args: any, reply: McpReplyFunction) => {
				try {
					const { path } = args || {};
					if (!path || typeof path !== "string") {
						return reply({
							error: {
								code: -32602,
								message: "path parameter is required and must be a string",
							},
						});
					}
					const normalized = normalizePath(path);
					if (!normalized) {
						return reply({
							error: { code: -32602, message: "invalid file path" },
						});
					}

					const file = this.app.vault.getAbstractFileByPath(normalized);
					if (!file || !(file instanceof TFile)) {
						return reply({
							error: { code: -32603, message: `File not found: ${normalized}` },
						});
					}

					// Refuse markdown — `view` is the right tool. The Text
					// Extractor's purpose is non-markdown formats; routing
					// markdown through it adds latency and risks confusing
					// callers about which tool to use.
					if (file.extension === "md") {
						return reply({
							error: {
								code: -32602,
								message:
									"extract_text is for non-markdown files; use `view` for markdown",
							},
						});
					}

					const api = getPluginApi(this.app, PLUGIN_TEXT_EXTRACTOR);
					if (
						!api ||
						typeof api.canFileBeExtracted !== "function" ||
						typeof api.extractText !== "function"
					) {
						return reply({
							error: {
								code: -32603,
								message:
									"Text Extractor plugin is not available (was it disabled after server start?)",
							},
						});
					}

					const can = await api.canFileBeExtracted(file.path);
					if (!can) {
						return reply({
							error: {
								code: -32602,
								message: `Text Extractor cannot process .${file.extension} files`,
							},
						});
					}

					const text = await api.extractText(file);
					if (typeof text !== "string") {
						return reply({
							error: {
								code: -32603,
								message: `Text Extractor returned non-string for ${file.path}`,
							},
						});
					}

					const truncated = text.length > EXTRACT_TEXT_MAX_BYTES;
					const out = truncated ? text.slice(0, EXTRACT_TEXT_MAX_BYTES) : text;
					const header = truncated
						? `Extracted ${out.length} of ${text.length} chars from ${file.path} (TRUNCATED at ${EXTRACT_TEXT_MAX_BYTES}-byte budget)\n\n`
						: `Extracted ${text.length} chars from ${file.path}\n\n`;

					return reply({
						result: { content: [{ type: "text", text: header + out }] },
					});
				} catch (error: any) {
					reply({
						error: {
							code: -32603,
							message: `extract_text failed: ${error?.message ?? error}`,
						},
					});
				}
			},
		};
	}

	// ── dataview_query ─────────────────────────────────────────────────

	private dataviewImpl(): ToolImplementation {
		return {
			name: "dataview_query",
			handler: async (args: any, reply: McpReplyFunction) => {
				try {
					const { query } = args || {};
					if (!query || typeof query !== "string") {
						return reply({
							error: {
								code: -32602,
								message: "query parameter is required and must be a string",
							},
						});
					}

					const api = getPluginApi(this.app, PLUGIN_DATAVIEW);
					if (!api || typeof api.queryMarkdown !== "function") {
						return reply({
							error: {
								code: -32603,
								message:
									"Dataview plugin is not available (was it disabled after server start?)",
							},
						});
					}

					const r = await api.queryMarkdown(query);
					if (!r || r.successful !== true) {
						// DQL parse / evaluation error. Per MCP spec
						// 2025-11-25 clarification, "input validation
						// errors should be returned as Tool Execution
						// Errors rather than Protocol Errors to enable
						// model self-correction" — so we surface this as
						// `result.isError: true` instead of a JSON-RPC
						// -32602. The model can read the DQL parser's
						// error message and try a corrected query.
						const errMsg =
							r?.error ?? "Dataview returned an unsuccessful result";
						return reply({
							result: {
								isError: true,
								content: [
									{
										type: "text",
										text: `DQL query failed:\n${errMsg}`,
									},
								],
							},
						});
					}

					return reply({
						result: {
							content: [{ type: "text", text: r.value ?? "(no rows)" }],
						},
					});
				} catch (error: any) {
					reply({
						error: {
							code: -32603,
							message: `dataview_query failed: ${error?.message ?? error}`,
						},
					});
				}
			},
		};
	}
}

// ──────────────────────────────────────────────────────────────────────
// Formatting helpers

interface OmnisearchHit {
	path: string;
	score?: number;
	basename?: string;
	foundWords?: string[];
	matches?: any[];
}

function formatOmnisearchResults(
	query: string,
	results: OmnisearchHit[],
	totalAvailable: number
): string {
	if (results.length === 0) {
		return `No matches for "${query}".`;
	}
	const headerSuffix =
		totalAvailable > results.length
			? ` (showing top ${results.length} of ${totalAvailable})`
			: "";
	const lines: string[] = [
		`Omnisearch results for "${query}"${headerSuffix}:`,
	];
	for (const r of results) {
		const score = typeof r.score === "number" ? r.score.toFixed(1) : "?";
		const matchCount = Array.isArray(r.matches) ? r.matches.length : 0;
		const top = Array.isArray(r.foundWords)
			? r.foundWords.slice(0, 4).join(", ")
			: "";
		const matchHint = top ? `  matches: [${top}${r.foundWords && r.foundWords.length > 4 ? ", …" : ""}]` : "";
		lines.push(
			`  [score ${score}] ${r.path}  (${matchCount} excerpts)${matchHint}`
		);
	}
	return lines.join("\n");
}
