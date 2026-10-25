import type { AutoRAGAgentOptions } from "@autorag/librarian";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAskUserTool } from "./ask-user-tool";
import { createHostUi, type RunInteraction } from "./host-ui";

type AgentTool = NonNullable<AutoRAGAgentOptions["tools"]>[number];

/**
 * What one AutoRAG agent needs to put its questions in front of the person.
 *
 * - `askUserTool` goes in the agent's `tools`: the librarian's system prompt names `ask_user` when a tool of
 *   that name exists, and this one opens its question in the AI Search panel.
 * - `ui` is bound to the chat's pi session (`InteractiveSearchAgent.openSession`, the way pi's RPC mode binds its
 *   host: `session.bindExtensions({ uiContext, mode: "rpc" })`, again after every replaced session), so the
 *   librarian's file-change gate can ask for approval.
 * - `bind` names the run the questions belong to; between runs nobody can be asked.
 */
export interface AgentInteraction {
	readonly askUserTool: AgentTool;
	readonly ui: ExtensionUIContext;
	bind(run: RunInteraction | undefined): void;
}

export function createAgentInteraction(): AgentInteraction {
	let current: RunInteraction | undefined;
	return {
		askUserTool: createAskUserTool(() => current),
		ui: createHostUi(() => current),
		bind: (run) => {
			current = run;
		},
	};
}
