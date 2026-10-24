import type { AutoRAGAgentOptions } from "@autorag/librarian";
import type { ApprovalMode } from "../shared/interaction-contract";
import { type AgentInteraction, bindSessionsToHostUi } from "./agent-interaction";
import { AttachmentContextAgent } from "./attachment-context";
import type { RunInteraction } from "./host-ui";

/**
 * The AI Search agent: the librarian agent with attachment context, able to ask the person.
 *
 * The person answers in the AI Search panel: `ask_user` questions, and the approvals the librarian's
 * file-change gate asks for in `ask` and `auto` mode. {@link bindRun} says which run is asking.
 */
export class InteractiveSearchAgent extends AttachmentContextAgent {
	readonly #interaction: AgentInteraction;

	constructor(options: AutoRAGAgentOptions, interaction: AgentInteraction) {
		super({ ...options, tools: [...(options.tools ?? []), interaction.askUserTool] });
		this.#interaction = interaction;
		bindSessionsToHostUi(this, interaction.ui);
	}

	/** The run the next dialogs belong to; `undefined` once it ended. */
	bindRun(run: RunInteraction | undefined): void {
		this.#interaction.bind(run);
	}

	/** Takes effect on the next gated call; the session's "allow for this session" grants end with the old mode. */
	setApprovalMode(mode: ApprovalMode): void {
		this.permissionControl.set(mode);
	}
}
