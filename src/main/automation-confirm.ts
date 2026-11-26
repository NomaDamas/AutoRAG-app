import type { AutomationDraft, AutomationEventType } from "../shared/automation-contract";
import type { RunInteraction } from "./host-ui";

/**
 * A rule the agent saves with `manage_automations` waits for the person (Figma 672:3740): the chat shows it filled in,
 * as the 언제 sentence and the 할 일 line, and it is written only when they press 추가하기, with whatever they changed.
 * Skipping it saves nothing, and the agent is told so. Every other action (list, delete, run, the service) and a save
 * with nobody to ask (no run is bound) go through untouched.
 */

const ALL_EVENTS: readonly AutomationEventType[] = ["create", "update", "delete"];

interface SaveBody {
	readonly paths: readonly string[];
	readonly events?: readonly AutomationEventType[];
	readonly include?: readonly string[];
	readonly run?: readonly string[];
	readonly agent?: { readonly profile: string; readonly task: string; readonly [key: string]: unknown };
	readonly [key: string]: unknown;
}

interface ToolParams {
	readonly action: string;
	readonly id?: string;
	readonly automation?: SaveBody;
	readonly [key: string]: unknown;
}

interface PatchableTool {
	readonly name: string;
	execute: (toolCallId: string, params: ToolParams, ...rest: unknown[]) => Promise<unknown>;
}

/** The rule as the card draws it: the librarian's defaults spelled out, so the chips show what will run. */
export function draftOf(body: SaveBody): AutomationDraft {
	return {
		paths: body.paths,
		events: body.events ?? ALL_EVENTS,
		include: body.include ?? [],
		...(body.agent === undefined ? {} : { agent: { profile: body.agent.profile, task: body.agent.task } }),
		...(body.run === undefined ? {} : { run: body.run }),
	};
}

/** The agent's body with the person's changes: what the card does not show (exclude, appendFiles, retrieval…) stays. */
export function mergeDraft(body: SaveBody, rule: AutomationDraft): SaveBody {
	const { run: _run, agent: _agent, ...rest } = body;
	return {
		...rest,
		paths: rule.paths,
		events: rule.events,
		include: rule.include,
		...(rule.agent === undefined ? {} : { agent: { ...(body.agent ?? {}), profile: rule.agent.profile, task: rule.agent.task } }),
		...(rule.run === undefined ? {} : { run: rule.run }),
	};
}

const SKIPPED = "The user did not add this automation, so nothing was saved. Do not save it again unless the user asks.";

export function wrapSave(execute: PatchableTool["execute"], current: () => RunInteraction | undefined): PatchableTool["execute"] {
	return async (toolCallId, params, ...rest) => {
		const run = current();
		if (params.action !== "save" || params.automation === undefined || run === undefined) return execute(toolCallId, params, ...rest);
		const signal = rest.find((value): value is AbortSignal => typeof AbortSignal !== "undefined" && value instanceof AbortSignal);
		const answer = await run.open({ kind: "automation", ruleId: params.id ?? "", rule: draftOf(params.automation) }, signal);
		if (answer.kind !== "automation") {
			return { content: [{ type: "text", text: SKIPPED }], details: { action: "save", ...(params.id === undefined ? {} : { id: params.id }) } };
		}
		return execute(toolCallId, { ...params, automation: mergeDraft(params.automation, answer.rule) }, ...rest);
	};
}

/** Hold the agent's automation saves for the person. Throws when the agent has no such tool, like `runAutomationToolOnNode`. */
export function confirmAutomationSaves(agent: object, current: () => RunInteraction | undefined): void {
	const tools = (agent as { readonly tools?: readonly PatchableTool[] }).tools;
	const tool = Array.isArray(tools) ? tools.find((candidate) => candidate.name === "manage_automations") : undefined;
	if (tool === undefined) throw new Error("The librarian agent has no manage_automations tool to confirm saves on.");
	tool.execute = wrapSave(tool.execute.bind(tool), current);
}
