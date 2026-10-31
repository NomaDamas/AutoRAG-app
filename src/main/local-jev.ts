import type { AutoRAGAgentOptions } from "@autorag/librarian";
import { AUTORAG_PROVIDER_ID } from "../shared/account-contract";
import { readDazziPlanCredential } from "./dazzi-plan-credential";
import { analyzeShellCommand } from "./read-only-shell";

/**
 * A stand-in judgement backend for the librarian's file-change gate, used when the configured Jev backend has no
 * credential (a BYOK sign-in without OpenRouter, the librarian's default). Without it every `bash` call, `ls` and
 * `cat` included, is "unclassified" and goes to the person, so one answer takes several approvals.
 *
 * It answers only the gate's own questions, and only for a command {@link analyzeShellCommand} can prove read-only:
 * those get "changes nothing" for every category. For anything else it refuses, which the gate reads as "could not
 * classify" and asks the person, exactly as with no judgement at all. Other Jev questions (query routing, the `jev`
 * tool) are refused too, so they behave as before.
 */

type JevOption = AutoRAGAgentOptions["jev"];
type JevSettings = Exclude<JevOption, false | undefined>;
type JevBackendInstance = Exclude<NonNullable<JevSettings["backend"]>, string>;

/** What the backend reads of jev-use's request: the state and the ids of the questions asked. */
interface BackendRequest {
	readonly state: unknown;
	readonly questions: readonly { readonly id: string }[];
}

/** One raw answer per question, in order: a probability for the gate's noul questions, an option label for its choice. */
interface BackendResponse {
	answers: { answer: number | string; confidence?: number }[];
}

/** The librarian's gate: one noul question per kind of change, then the "may this run unasked" choice (permission-judgment.ts). */
const GATE_KIND_QUESTION = /^permission_(?:delete|move|rename|overwrite|edit|unclear)$/u;
const GATE_APPROVAL_QUESTION = "permission_gate";

/** What the gate's state says before and after the command (permission-judgment.ts `describeProposedCall`). */
const COMMAND_PREFIX = "Proposed tool call (bash), working directory ";
const COMMAND_TRAILER = "\n\nPaths named in the call, and whether each exists right now:\n";

/** A probability low enough that no category is flagged (the gate flags from 0.2) and sure enough for jev-use not to escalate it. */
const NO_CHANGE = 0.02;

/**
 * The bash command inside the state the gate shows Jev, or null when the state is not a bash call or its shape is
 * not exactly the one expected. Each marker must occur once: the command, a user message or a path name could
 * contain the marker text and so choose what part of the state is read as the command.
 */
export function extractBashCommand(state: unknown): string | null {
	if (typeof state !== "string") return null;
	const prefixAt = state.indexOf(COMMAND_PREFIX);
	const trailerAt = state.indexOf(COMMAND_TRAILER);
	if (prefixAt < 0 || trailerAt < 0) return null;
	if (state.lastIndexOf(COMMAND_PREFIX) !== prefixAt || state.lastIndexOf(COMMAND_TRAILER) !== trailerAt) return null;
	const lineEnd = state.indexOf("\n", prefixAt);
	if (lineEnd < 0 || lineEnd > trailerAt || state.charAt(lineEnd - 1) !== ":") return null;
	return state.slice(lineEnd + 1, trailerAt);
}

export function createLocalReadOnlyJevBackend(): JevBackendInstance {
	return {
		name: "local-rules",
		async judge(request: BackendRequest): Promise<BackendResponse> {
			if (!request.questions.every((question) => GATE_KIND_QUESTION.test(question.id) || question.id === GATE_APPROVAL_QUESTION)) {
				throw new Error("the local rules only judge whether a command changes files");
			}
			const command = extractBashCommand(request.state);
			if (command === null) throw new Error("the local rules only judge a bash command");
			const verdict = analyzeShellCommand(command);
			if (!verdict.readOnly) throw new Error(`not proven to only read: ${verdict.why}`);
			return {
				answers: request.questions.map((question) =>
					question.id === GATE_APPROVAL_QUESTION ? { answer: "allow", confidence: 1 } : { answer: NO_CHANGE },
				),
			};
		},
	};
}

/** The environment variables jev-use reads each of its own backends' key from. */
const KEY_VARIABLES: Readonly<Record<"typesafe" | "openrouter" | "vercel", readonly string[]>> = {
	typesafe: ["TYPESAFE_API_KEY", "TYPESAFE_AI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	vercel: ["AI_GATEWAY_API_KEY"],
};

/**
 * `jev` as the agent should get it: unchanged when its backend can be built, else with the local rules as the
 * backend (settings such as `model` kept). Mirrors jev-use's own credential lookup, so "can be built" here is
 * "will not throw about a missing key" there. A backend the caller already built is not second-guessed.
 */
export async function withLocalJevFallback(
	jev: JevOption,
	context: { readonly env: Readonly<Record<string, string | undefined>>; readonly agentDir: string },
): Promise<JevOption> {
	if (jev === undefined || jev === false) return jev;
	const env = context.env;
	const named = jev.backend ?? (env.JEV_BACKEND?.toLowerCase() === AUTORAG_PROVIDER_ID ? AUTORAG_PROVIDER_ID : undefined);
	if (typeof named === "object") return jev;
	const usable =
		named === AUTORAG_PROVIDER_ID
			? (await readDazziPlanCredential(context.agentDir)) !== null
			: Object.entries(KEY_VARIABLES).some(
					([backend, variables]) => (named === undefined || named === backend) && variables.some((variable) => (env[variable] ?? "").length > 0),
				);
	return usable ? jev : { ...jev, backend: createLocalReadOnlyJevBackend() };
}
