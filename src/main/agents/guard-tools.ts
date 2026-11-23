import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../../shared/secret-guard";

/**
 * Wraps tools so nothing they return carries a credential to the model, whatever the tool did.
 *
 * Every tool of a Settings assistant is written not to return a secret; this is the net underneath for the case where one
 * does by mistake (a command's output, a server's reply, an error message quoting a header). `known` is the live set of
 * secret values this conversation handled, read at call time so a value stored after wrapping is covered too.
 */
export function guardTools(tools: readonly ToolDefinition[], known: ReadonlySet<string>): readonly ToolDefinition[] {
	return tools.map((tool) => ({
		...tool,
		execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
			const result = await tool.execute(...args);
			const values = [...known];
			return {
				...result,
				content: result.content.map((part) => (part.type === "text" ? { ...part, text: redactSecrets(part.text, values) } : part)),
				details: result.details === undefined ? undefined : JSON.parse(redactSecrets(JSON.stringify(result.details), values)),
			};
		},
	})) as readonly ToolDefinition[];
}
