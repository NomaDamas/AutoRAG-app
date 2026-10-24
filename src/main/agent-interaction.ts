import type { AutoRAGAgent, AutoRAGAgentOptions } from "@autorag/librarian";
import { AgentSession, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAskUserTool } from "./ask-user-tool";
import { createHostUi, type RunInteraction } from "./host-ui";

type AgentTool = NonNullable<AutoRAGAgentOptions["tools"]>[number];

/**
 * What one AutoRAG agent needs to put its questions in front of the person.
 *
 * - `askUserTool` goes in the agent's `tools`: the librarian's system prompt names `ask_user` when a tool of
 *   that name exists, and this one opens its question in the AI Search panel.
 * - `ui` is bound to the pi session of every search run ({@link bindSessionsToHostUi}), so the librarian's
 *   file-change gate can ask for approval.
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

/** The pi session inside a librarian search session (`{ piSession, agent, prompt, ... }`), when it has one. */
function piSessionOf(searchSession: unknown): AgentSession | undefined {
	if (typeof searchSession !== "object" || searchSession === null || !("piSession" in searchSession)) return undefined;
	return searchSession.piSession instanceof AgentSession ? searchSession.piSession : undefined;
}

/**
 * Binds `ui` to every pi session `agent` creates for a search.
 *
 * The librarian's headless search session has no UI of its own (only its terminal client binds one), so the
 * gate would find nobody to ask and block every call it cannot approve itself. pi documents the runner's
 * `setUIContext` for exactly this: a host that is not a TUI supplies the dialogs (pi's RPC mode does the same).
 * The librarian exposes no option for it, so the one place a session is born, its private `createSearchSession`
 * (its type is erased from the package's declarations), is wrapped on this instance. A librarian release that
 * renames it fails here at construction, loudly, instead of leaving the gate with nobody to ask; the agent
 * integration test covers the same path end to end.
 */
export function bindSessionsToHostUi(agent: AutoRAGAgent, ui: ExtensionUIContext): void {
	const create: unknown = Reflect.get(agent, "createSearchSession");
	if (typeof create !== "function") {
		throw new Error("The librarian no longer has AutoRAGAgent.createSearchSession: bind the host UI another way.");
	}
	Reflect.set(agent, "createSearchSession", async (...args: unknown[]): Promise<unknown> => {
		const session: unknown = await Reflect.apply(create, agent, args);
		piSessionOf(session)?.extensionRunner.setUIContext(ui, "rpc");
		return session;
	});
}
