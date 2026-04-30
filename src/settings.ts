import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import ClaudeMcpPlugin from "../main";
import { getClaudeConfigDir } from "./claude-config";
import { generateToken } from "./mcp/auth";

export interface ClaudeCodeSettings {
	autoCloseTerminalOnClaudeExit: boolean;
	startupCommand: string;
	mcpHttpPort: number;
	enableWebSocketServer: boolean;
	enableHttpServer: boolean;
	enableEmbeddedTerminal: boolean;
	/**
	 * Bearer token used to authenticate clients on both transports. Generated
	 * automatically on first plugin load if empty. The user can rotate it
	 * from the settings tab.
	 */
	mcpAuthToken: string;
}

export const DEFAULT_SETTINGS: ClaudeCodeSettings = {
	autoCloseTerminalOnClaudeExit: true,
	startupCommand: "claude",
	mcpHttpPort: 22360,
	enableWebSocketServer: true,
	enableHttpServer: true,
	enableEmbeddedTerminal: true,
	mcpAuthToken: "", // populated on first load
};

/**
 * Mutates `settings` in place: ensures `mcpAuthToken` is non-empty,
 * generating one if needed. Returns true when a new token was minted
 * (caller should persist).
 */
export function ensureAuthToken(settings: ClaudeCodeSettings): boolean {
	if (!settings.mcpAuthToken || settings.mcpAuthToken.trim() === "") {
		settings.mcpAuthToken = generateToken();
		return true;
	}
	return false;
}

export class ClaudeCodeSettingTab extends PluginSettingTab {
	plugin: ClaudeMcpPlugin;

	constructor(app: App, plugin: ClaudeMcpPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", { text: "Claude Code Settings" });

		// MCP Server Status Section
		this.displayServerStatus(containerEl);

		// MCP Server Configuration Section
		containerEl.createEl("h3", { text: "MCP Server Configuration" });

		new Setting(containerEl)
			.setName("Enable WebSocket Server")
			.setDesc(
				"Enable WebSocket server for Claude Code IDE integration. This allows auto-discovery via lock files."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableWebSocketServer)
					.onChange(async (value) => {
						this.plugin.settings.enableWebSocketServer = value;
						await this.plugin.saveSettings();
						await this.plugin.restartMcpServer();
						// Refresh the display to show updated status
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Enable HTTP/SSE Server")
			.setDesc(
				"Enable HTTP/SSE server for Claude Desktop and other MCP clients. Required for manual MCP client configuration."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableHttpServer)
					.onChange(async (value) => {
						this.plugin.settings.enableHttpServer = value;
						await this.plugin.saveSettings();
						await this.plugin.restartMcpServer();
						// Refresh the display to show updated status
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("HTTP Server Port")
			.setDesc(
				"Port for the HTTP/SSE MCP server. Default is 22360 to avoid conflicts with common dev services. Changes will apply when you leave this field."
			)
			.addText((text) => {
				text
					.setPlaceholder("22360")
					.setValue(this.plugin.settings.mcpHttpPort.toString())
					.onChange(async (value) => {
						const port = parseInt(value);
						if (isNaN(port) || port < 1024 || port > 65535) {
							return;
						}
						// Only save the setting, don't restart the server yet
						this.plugin.settings.mcpHttpPort = port;
						await this.plugin.saveSettings();
					});
				
				// Restart server only on blur
				text.inputEl.addEventListener("blur", async () => {
					const value = text.getValue();
					const port = parseInt(value);
					if (isNaN(port) || port < 1024 || port > 65535) {
						text.setValue(this.plugin.settings.mcpHttpPort.toString());
						return;
					}
					// Only restart if the server is enabled
					if (this.plugin.settings.enableHttpServer) {
						await this.plugin.restartMcpServer();
						// Refresh the display to show updated status
						this.display();
					}
				});
			});

		// Authentication Section
		this.displayAuthSection(containerEl);

		// Terminal Configuration Section
		containerEl.createEl("h3", { text: "Terminal Configuration" });

		new Setting(containerEl)
			.setName("Enable Embedded Terminal")
			.setDesc(
				"Enable the built-in terminal feature within Obsidian. When disabled, you can still use external MCP clients like Claude Desktop or Claude Code IDE. Requires plugin reload to take effect."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableEmbeddedTerminal)
					.onChange(async (value) => {
						this.plugin.settings.enableEmbeddedTerminal = value;
						await this.plugin.saveSettings();

						// Dynamically manage ribbon icon
						if (value) {
							this.plugin.addTerminalRibbonIcon();
						} else {
							this.plugin.removeTerminalRibbonIcon();
						}

						new Notice(
							"Terminal setting changed. Please reload the plugin for full changes to take effect.",
							5000
						);
					})
			);

		if (this.plugin.settings.enableEmbeddedTerminal) {
			new Setting(containerEl)
				.setName("Auto-close terminal when Claude exits")
				.setDesc(
					"Automatically close the terminal view when the Claude command exits. If disabled, the terminal will remain open as a regular shell."
				)
				.addToggle((toggle) =>
					toggle
						.setValue(
							this.plugin.settings.autoCloseTerminalOnClaudeExit
						)
						.onChange(async (value) => {
							this.plugin.settings.autoCloseTerminalOnClaudeExit =
								value;
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Startup command")
				.setDesc(
					"Command to run automatically when the terminal opens. Use an empty string to disable auto-launch."
				)
				.addText((text) =>
					text
						.setPlaceholder("claude -c")
						.setValue(this.plugin.settings.startupCommand)
						.onChange(async (value) => {
							this.plugin.settings.startupCommand = value;
							await this.plugin.saveSettings();
						})
				);
		}
	}

	private displayServerStatus(containerEl: HTMLElement): void {
		const statusSection = containerEl.createEl("div", {
			cls: "mcp-server-status",
		});
		statusSection.createEl("h3", { text: "MCP Server Status" });

		// Get server info from the plugin
		const serverInfo = this.plugin.mcpServer?.getServerInfo() || {};

		// WebSocket Server Status
		const wsContainer = statusSection.createEl("div", {
			cls: "server-status-item",
		});
		wsContainer.createEl("h4", { text: "WebSocket Server (Claude Code)" });

		const wsStatus = wsContainer.createEl("div", { cls: "status-line" });
		if (this.plugin.settings.enableWebSocketServer && serverInfo.wsPort) {
			wsStatus.innerHTML = `
				<span class="status-indicator status-running">●</span>
				<span class="status-text">Running on port ${serverInfo.wsPort}</span>
				<span class="status-clients">(${serverInfo.wsClients || 0} clients)</span>
			`;

			const wsDetails = wsContainer.createEl("div", {
				cls: "status-details",
			});
			const configDir = getClaudeConfigDir();
			wsDetails.innerHTML = `
				<div>• Auto-discovery enabled via lock files</div>
				<div>• Lock file: <code>${configDir}/ide/${serverInfo.wsPort}.lock</code></div>
				<div>• Use <code>claude</code> CLI and select "Obsidian" from <code>/ide</code> list</div>
			`;
		} else if (!this.plugin.settings.enableWebSocketServer) {
			wsStatus.innerHTML = `
				<span class="status-indicator status-disabled">●</span>
				<span class="status-text">Disabled</span>
			`;
		} else {
			wsStatus.innerHTML = `
				<span class="status-indicator status-error">●</span>
				<span class="status-text">Failed to start</span>
			`;
		}

		// HTTP/SSE Server Status
		const httpContainer = statusSection.createEl("div", {
			cls: "server-status-item",
		});
		httpContainer.createEl("h4", {
			text: "MCP Server (HTTP/SSE transport)",
		});

		const httpStatus = httpContainer.createEl("div", {
			cls: "status-line",
		});
		if (this.plugin.settings.enableHttpServer && serverInfo.httpPort) {
			httpStatus.innerHTML = `
				<span class="status-indicator status-running">●</span>
				<span class="status-text">Running on port ${serverInfo.httpPort}</span>
				<span class="status-clients">(${serverInfo.httpClients || 0} clients)</span>
			`;

			const httpDetails = httpContainer.createEl("div", {
				cls: "status-details",
			});
			httpDetails.innerHTML = `
				<div>• SSE Stream: <code>http://localhost:${serverInfo.httpPort}/sse</code></div>
				<div>• Bearer token required — see Authentication section below for full client config</div>
			`;
		} else if (!this.plugin.settings.enableHttpServer) {
			httpStatus.innerHTML = `
				<span class="status-indicator status-disabled">●</span>
				<span class="status-text">Disabled</span>
			`;
		} else {
			httpStatus.innerHTML = `
				<span class="status-indicator status-error">●</span>
				<span class="status-text">Failed to start</span>
			`;
		}

		// Add refresh button
		const refreshContainer = statusSection.createEl("div", {
			cls: "status-refresh",
		});
		const refreshButton = refreshContainer.createEl("button", {
			text: "Refresh Status",
			cls: "mod-cta",
		});
		refreshButton.addEventListener("click", () => {
			this.display(); // Refresh the entire settings display
		});
	}

	private displayAuthSection(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Authentication" });

		// Build identity — version from manifest plus the build timestamp
		// injected by esbuild. Lets us tell at a glance which bundle is
		// actually loaded, since Obsidian sometimes caches plugin code.
		const buildBox = containerEl.createEl("div", {
			cls: "setting-item-description",
		});
		buildBox.style.marginBottom = "0.75em";
		buildBox.style.fontFamily = "var(--font-monospace)";
		buildBox.style.fontSize = "0.85em";
		buildBox.style.opacity = "0.8";
		buildBox.setText(
			`v${this.plugin.manifest.version} · built ${__BUILD_STAMP__}`
		);

		const desc = containerEl.createEl("div", { cls: "setting-item-description" });
		desc.createEl("p", {
			text:
				"All MCP connections require this bearer token. Claude Code reads it " +
				"from the lock file automatically. For Claude Desktop / mcp-remote, " +
				"include it in the configuration shown below.",
		});

		const token = this.plugin.settings.mcpAuthToken;
		const port = this.plugin.mcpServer?.getServerInfo()?.httpPort ?? this.plugin.settings.mcpHttpPort;

		// Token field — shown in plain text. The same value appears in the
		// config snippet below, so masking it here would be theater, not
		// security. The actual control is the local-machine boundary
		// (loopback-only HTTP server + lock-file delivery for WS).
		const tokenSetting = new Setting(containerEl)
			.setName("Bearer token")
			.setDesc("Generated automatically. Rotate it if you suspect it has leaked.");

		tokenSetting.addText((text) => {
			text.setValue(token).setDisabled(true);
			text.inputEl.style.fontFamily = "var(--font-monospace)";
			text.inputEl.style.width = "100%";
		});

		tokenSetting.addButton((btn) => {
			btn.setButtonText("Copy").onClick(async () => {
				try {
					await navigator.clipboard.writeText(token);
					new Notice("Token copied to clipboard");
				} catch (err) {
					new Notice("Failed to copy token");
				}
			});
		});

		tokenSetting.addButton((btn) => {
			btn.setButtonText("Regenerate")
				.setWarning()
				.onClick(async () => {
					const ok = window.confirm(
						"Generate a new token? All currently connected Claude clients " +
							"will be disconnected and must be reconfigured with the new token."
					);
					if (!ok) return;
					this.plugin.settings.mcpAuthToken = generateToken();
					await this.plugin.saveSettings();
					await this.plugin.restartMcpServer();
					new Notice("Auth token regenerated. Update your Claude clients.");
					this.display();
				});
		});

		// Configuration snippet for Claude Desktop / mcp-remote.
		const cfgContainer = containerEl.createEl("div", { cls: "setting-item-description" });
		cfgContainer.createEl("p", { text: "Claude Desktop config snippet (claude_desktop_config.json):" });
		const pre = cfgContainer.createEl("pre");
		pre.style.userSelect = "text";
		pre.style.padding = "0.5em";
		pre.style.backgroundColor = "var(--background-secondary)";
		pre.style.borderRadius = "4px";
		pre.style.overflowX = "auto";
		pre.createEl("code", {
			text: JSON.stringify(
				{
					mcpServers: {
						obsidian: {
							command: "npx",
							args: [
								"-y",
								"mcp-remote",
								`http://localhost:${port}/sse`,
								"--header",
								`Authorization: Bearer ${token}`,
							],
						},
					},
				},
				null,
				2
			),
		});
	}
}
