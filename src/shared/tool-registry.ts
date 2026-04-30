import { Tool, McpRequest, McpReplyFunction } from "../mcp/types";

export interface ToolImplementation {
	name: string;
	handler: (args: any, reply: McpReplyFunction) => Promise<void>;
}

export interface ToolDefinition extends Tool {
	category: "general" | "ide-specific" | "file" | "workspace";
}

export class ToolRegistry {
	private tools = new Map<
		string,
		{
			definition: ToolDefinition;
			implementation: ToolImplementation;
		}
	>();

	register(
		definition: ToolDefinition,
		implementation: ToolImplementation
	): void {
		if (definition.name !== implementation.name) {
			throw new Error(
				`Tool definition name "${definition.name}" doesn't match implementation name "${implementation.name}"`
			);
		}

		this.tools.set(definition.name, { definition, implementation });
	}

	async handleToolCall(
		req: McpRequest,
		reply: McpReplyFunction
	): Promise<void> {
		const { name, arguments: args } = req.params || {};

		if (!name || typeof name !== "string") {
			return reply({
				error: {
					code: -32602,
					message: "tools/call requires a string `name` parameter",
				},
			});
		}

		const tool = this.tools.get(name);
		if (!tool) {
			console.error(`[ToolRegistry] Unknown tool called: ${name}`, args);
			return reply({
				error: {
					code: -32602,
					message: `Unknown tool: ${name}`,
				},
			});
		}

		try {
			await tool.implementation.handler(args, reply);
		} catch (error: any) {
			reply({
				error: {
					code: -32603,
					message: `failed to call tool ${name}: ${error.message}`,
				},
			});
		}
	}

	getToolDefinitions(category?: string): Tool[] {
		const definitions: Tool[] = [];
		for (const { definition } of this.tools.values()) {
			if (!category || definition.category === category) {
				// Return Tool without the category field
				const { category: _, ...toolDef } = definition;
				definitions.push(toolDef);
			}
		}
		return definitions;
	}

	getRegisteredToolNames(): string[] {
		return Array.from(this.tools.keys());
	}

	hasImplementation(name: string): boolean {
		return this.tools.has(name);
	}
}
