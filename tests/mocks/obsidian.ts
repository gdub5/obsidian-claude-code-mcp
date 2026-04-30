/**
 * Minimal mock of the `obsidian` module surface used by the plugin's
 * non-UI code paths (handlers, tools, servers). Anything UI-shaped
 * (PluginSettingTab, Notice, addIcon, etc.) is stubbed just enough
 * to keep imports working in tests; tests should not exercise UI.
 */

export class TFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	constructor(path: string) {
		this.path = path;
		const segs = path.split("/");
		this.name = segs[segs.length - 1] ?? path;
		const dot = this.name.lastIndexOf(".");
		this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot >= 0 ? this.name.slice(dot + 1) : "";
	}
}

export class TFolder {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
}

export interface VaultAdapter {
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	getBasePath?(): string;
}

export class Vault {
	private files = new Map<string, string>();
	private folders = new Set<string>();
	adapter: VaultAdapter;
	private name: string;

	constructor(name = "test-vault", basePath = "/tmp/test-vault") {
		this.name = name;
		// Match real Obsidian (and the underlying Node fs): writing to a
		// path whose parent folder doesn't exist throws ENOENT. This is
		// the behavior that surfaced the `create` auto-mkdir bug.
		this.adapter = {
			read: async (p: string) => {
				if (!this.files.has(p)) throw new Error(`ENOENT: ${p}`);
				return this.files.get(p)!;
			},
			write: async (p: string, c: string) => {
				const parent = parentOf(p);
				if (parent && !this.folders.has(parent)) {
					throw new Error(`ENOENT: parent folder does not exist: ${parent}`);
				}
				this.files.set(p, c);
			},
			getBasePath: () => basePath,
		};
	}

	getName(): string {
		return this.name;
	}

	getFiles(): TFile[] {
		return Array.from(this.files.keys()).map((p) => new TFile(p));
	}

	/**
	 * Mirrors `app.vault.createFolder`. Creates the folder and every
	 * intermediate ancestor. Throws if the leaf folder already exists, just
	 * like the real API — callers handle that with try/catch.
	 */
	async createFolder(path: string): Promise<void> {
		if (this.folders.has(path)) {
			throw new Error(`Folder already exists: ${path}`);
		}
		// Walk up and ensure every ancestor is registered.
		const parts = path.split("/").filter(Boolean);
		let acc = "";
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			this.folders.add(acc);
		}
	}

	getAbstractFileByPath(p: string): TFile | TFolder | null {
		if (this.files.has(p)) return new TFile(p);
		if (this.folders.has(p)) return new TFolder(p);
		return null;
	}

	/**
	 * Mirrors `app.vault.create`. Higher-level than `adapter.write`:
	 *   - throws if the file already exists
	 *   - throws if the parent folder doesn't exist (per Obsidian docs;
	 *     does NOT auto-mkdir — callers must createFolder first)
	 */
	async create(path: string, content: string): Promise<TFile> {
		if (this.files.has(path)) {
			throw new Error(`File already exists: ${path}`);
		}
		const parent = parentOf(path);
		if (parent && !this.folders.has(parent)) {
			throw new Error(`Parent folder does not exist: ${parent}`);
		}
		this.files.set(path, content);
		return new TFile(path);
	}

	// ── test helpers — not part of the real Obsidian API ────────────────

	/**
	 * Seed a file at `path` with `content`. Auto-creates ancestor folders
	 * so test setup doesn't have to chain calls.
	 */
	__seed(path: string, content: string): void {
		const parent = parentOf(path);
		if (parent) this.__ensureFolder(parent);
		this.files.set(path, content);
	}

	__ensureFolder(path: string): void {
		const parts = path.split("/").filter(Boolean);
		let acc = "";
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			this.folders.add(acc);
		}
	}

	__hasFolder(path: string): boolean {
		return this.folders.has(path);
	}

	__hasFile(path: string): boolean {
		return this.files.has(path);
	}
}

function parentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? "" : p.slice(0, i);
}

export class Workspace {
	private activeFile: TFile | null = null;

	getActiveFile(): TFile | null {
		return this.activeFile;
	}

	// Test helper
	__setActiveFile(file: TFile | null): void {
		this.activeFile = file;
	}

	on(_event: string, _cb: any): any {
		return { unload: () => {} };
	}

	off(_ref: any): void {}

	getLeavesOfType(_type: string): any[] {
		return [];
	}
}

/**
 * Mock of Obsidian's MetadataCache. Real Obsidian builds these structures
 * by parsing every note's content; the mock is seeded explicitly via
 * `__setFileCache(path, cache)` so tests can pin exact link/tag topologies.
 *
 * `resolvedLinks` and `unresolvedLinks` mirror the real shape:
 *   { sourcePath: { targetPath: count } }
 * Tests can either set them directly via `__seedLinks` or compute them by
 * adding file caches with `links: [{ link: "target" }]` entries.
 */
export class MetadataCache {
	resolvedLinks: Record<string, Record<string, number>> = {};
	unresolvedLinks: Record<string, Record<string, number>> = {};
	private fileCaches = new Map<string, CachedMetadata>();

	getFileCache(file: TFile | null): CachedMetadata | null {
		if (!file) return null;
		return this.fileCaches.get(file.path) ?? null;
	}

	getFirstLinkpathDest(_link: string, _src: string): TFile | null {
		return null;
	}

	// ── test helpers ────────────────────────────────────────────────────

	__setFileCache(path: string, cache: CachedMetadata): void {
		this.fileCaches.set(path, cache);
	}

	/**
	 * Seed link topology declaratively. Call as:
	 *   metadataCache.__seedLinks({
	 *     "hub.md":   ["leaf-a.md", "leaf-b.md"],
	 *     "leaf-b.md": ["hub.md"],
	 *   });
	 * Populates resolvedLinks for both directions of lookup.
	 */
	__seedLinks(map: Record<string, string[]>): void {
		for (const [source, targets] of Object.entries(map)) {
			this.resolvedLinks[source] ??= {};
			for (const target of targets) {
				this.resolvedLinks[source][target] =
					(this.resolvedLinks[source][target] ?? 0) + 1;
			}
		}
	}

	__reset(): void {
		this.resolvedLinks = {};
		this.unresolvedLinks = {};
		this.fileCaches.clear();
	}
}

/**
 * Mirrors the shape of Obsidian's CachedMetadata. Tests only need to set
 * the fields they're exercising; everything else stays undefined.
 */
export interface CachedMetadata {
	frontmatter?: Record<string, any>;
	tags?: Array<{ tag: string; position?: any }>;
	links?: Array<{ link: string; original?: string; position?: any }>;
	embeds?: Array<{ link: string; original?: string }>;
	headings?: Array<{ heading: string; level: number }>;
}

export class App {
	vault: Vault;
	workspace: Workspace;
	metadataCache: MetadataCache;

	constructor(vault?: Vault) {
		this.vault = vault ?? new Vault();
		this.workspace = new Workspace();
		this.metadataCache = new MetadataCache();
	}
}

// UI stubs — present so production imports don't blow up in test runs.
export class Plugin {
	app: App;
	constructor(app?: App) {
		this.app = app ?? new App();
	}
	addRibbonIcon(): any {
		return null;
	}
	addCommand(): void {}
	addSettingTab(): void {}
	registerView(): void {}
	async loadData(): Promise<any> {
		return {};
	}
	async saveData(_d: any): Promise<void> {}
}

export class PluginSettingTab {
	app: App;
	containerEl: any = { empty: () => {}, createEl: () => ({}) };
	constructor(app: App, _plugin: any) {
		this.app = app;
	}
}

export class Setting {
	constructor(_containerEl: any) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	addToggle(): this {
		return this;
	}
	addText(): this {
		return this;
	}
	addButton(): this {
		return this;
	}
}

export class Notice {
	constructor(_msg: string, _timeout?: number) {}
}

export class WorkspaceLeaf {}

export function addIcon(_id: string, _svg: string): void {}

export function normalizePath(p: string): string {
	return p;
}

/**
 * Mirrors Obsidian's `getAllTags(cache)` helper. Returns the merged set of
 * inline and frontmatter tags, each prefixed with `#`. Returns null for a
 * null cache, an empty array if a cache exists but contributes no tags.
 *
 * Frontmatter tag conventions handled:
 *   tags: [a, b]      → ["#a", "#b"]
 *   tags: "a, b"      → ["#a", "#b"]
 *   tag: "a"          → ["#a"]
 */
export function getAllTags(cache: CachedMetadata | null): string[] | null {
	if (!cache) return null;
	const out = new Set<string>();
	for (const t of cache.tags ?? []) out.add(t.tag);
	const fmRaw = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
	if (Array.isArray(fmRaw)) {
		for (const t of fmRaw) {
			if (typeof t === "string" && t.trim()) {
				out.add(`#${t.trim().replace(/^#/, "")}`);
			}
		}
	} else if (typeof fmRaw === "string") {
		for (const part of fmRaw.split(/[,\s]+/)) {
			if (part) out.add(`#${part.replace(/^#/, "")}`);
		}
	}
	return Array.from(out);
}
