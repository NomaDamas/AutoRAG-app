import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "@autorag/librarian/profiles";
import type { MagicActionAgentMode } from "../../../shared/context-menu-contract";
import { isSecretKey } from "../../autorag-config-service";
import { intentPromptLine, withIntentTools, type ReplyLanguage } from "../profile-progress";

const LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

const CREDENTIAL_NAME =
	/^(?:\.env(?:\..*)?|id_[a-z0-9]+(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keychain-db)|auth\.json|credentials(?:\..*)?|\.netrc|\.npmrc|\.pypirc)$/iu;

export interface MagicActionProfileInput {
	readonly language: ReplyLanguage;
	readonly mode: MagicActionAgentMode;
	readonly actionLabel: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly cancelled?: () => boolean;
}

function inside(child: string, root: string): boolean {
	return child === root || child.startsWith(`${root}${sep}`);
}

export function buildMagicActionUserMessage(paths: readonly string[], prompt: string): string {
	return [
		`Target file(s) (${paths.length}):`,
		...paths.map((p, idx) => `${idx + 1}. ${p}`),
		"",
		"Task:",
		prompt,
	].join("\n");
}

function createMagicActionTools(input: MagicActionProfileInput): readonly ToolDefinition[] {
	const isCancelled = input.cancelled ?? (() => false);
	const agentDirResolved = resolve(input.agentDir);
	const agentDirReal = realpath(agentDirResolved).catch(() => agentDirResolved);

	const absolute = (path: string): string => (isAbsolute(path) ? resolve(path) : resolve(input.cwd, path));

	async function guardPath(rawPath: string | undefined): Promise<void> {
		if (rawPath === undefined || rawPath === "") return;
		const resolved = absolute(rawPath);
		const real = await realpath(resolved).catch(() => resolved);
		const agentReal = await agentDirReal;
		if (inside(real, agentReal) || inside(resolved, agentDirResolved)) {
			throw new Error("Refused: Dazzi's internal sign-in and credential directory is off limits.");
		}
		if (CREDENTIAL_NAME.test(basename(resolved)) || CREDENTIAL_NAME.test(basename(real))) {
			throw new Error("Refused: credential and private key files are off limits.");
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: forwards tool execution after checking cancellation and credential fences.
	function guarded<T extends ToolDefinition<any, any, any>>(
		tool: T,
		check: (params: Record<string, unknown>) => Promise<void> | void,
	): T {
		const inner = tool.execute as (...args: unknown[]) => Promise<unknown>;
		return {
			...tool,
			execute: async (...args: unknown[]) => {
				if (isCancelled()) throw new Error("The Magic Action run was cancelled.");
				await check((args[1] ?? {}) as Record<string, unknown>);
				return inner(...args);
			},
		} as unknown as T;
	}

	const pathArg = (params: Record<string, unknown>): string | undefined =>
		typeof params.path === "string" ? params.path : undefined;

	const secretEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
		Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretKey(key)));

	const readTools: ToolDefinition[] = [
		guarded(createReadToolDefinition(input.cwd), (p) => guardPath(pathArg(p))),
		guarded(createLsToolDefinition(input.cwd), (p) => guardPath(pathArg(p))),
		guarded(createFindToolDefinition(input.cwd), (p) => guardPath(pathArg(p))),
		guarded(createGrepToolDefinition(input.cwd), (p) => guardPath(pathArg(p))),
	] as unknown as ToolDefinition[];

	if (input.mode === "read") {
		return withIntentTools(readTools, { language: input.language });
	}

	const bash = createBashToolDefinition(input.cwd, {
		spawnHook: (ctx) => ({ ...ctx, env: secretEnv({ ...ctx.env, ...input.env }) }),
	});

	const organizeTools: ToolDefinition[] = [
		...readTools,
		guarded(createEditToolDefinition(input.cwd), (p) => guardPath(pathArg(p))),
		guarded(createWriteToolDefinition(input.cwd), (p) => guardPath(pathArg(p))),
		guarded(bash, async (params) => {
			const command = typeof params.command === "string" ? params.command : "";
			const agentReal = await agentDirReal;
			if (command.includes(agentReal) || command.includes(agentDirResolved) || /\b(?:auth|models)\.json\b/u.test(command)) {
				throw new Error("Refused: Dazzi's internal sign-in and credential files are off limits.");
			}
		}),
	] as unknown as ToolDefinition[];

	return withIntentTools(organizeTools, { language: input.language });
}

function systemPrompt(input: MagicActionProfileInput): string {
	const replyLang = LANGUAGE_NAME[input.language];
	const modeRules =
		input.mode === "read"
			? [
					"- You are running in READ-ONLY analysis mode (`read`, `ls`, `find`, `grep`).",
					"- Inspect the target file(s) thoroughly and return a clear, well-structured Markdown answer for the user.",
				]
			: [
					"- You are running in ORGANIZE / ACTION mode (`read`, `ls`, `find`, `grep`, `edit`, `write`, `bash`).",
					"- You may create new files, convert or transform files, edit files, rename/move/organize, or run local CLI tools to fulfill the task.",
					"- Never permanently delete user files (`rm`, `rmdir`, `unlink`, `shred`); if a task explicitly asks to remove a file, move it to the OS Trash (`/usr/bin/trash` on macOS, `gio trash` on Linux).",
					"- Never overwrite unrelated existing files unless the instruction explicitly asks for it; report every created or modified path clearly in your final reply.",
				];
	return [
		`You are Dazzi's custom file right-click Magic Action agent ("${input.actionLabel}").`,
		`Always write your final reply in ${replyLang}.`,
		"",
		"## Rules",
		"- You run directly on the file(s) or folder(s) the user right-clicked in Finder.",
		"- Do not ask follow-up questions; complete the task autonomously from what you can inspect.",
		...modeRules,
		"",
		intentPromptLine(input.language),
	].join("\n");
}

export function magicActionProfile(input: MagicActionProfileInput): AgentProfile {
	return {
		id: "magic-action",
		systemPrompt: systemPrompt(input),
		tools: [],
		customTools: createMagicActionTools(input),
		thinking: "low",
	};
}
