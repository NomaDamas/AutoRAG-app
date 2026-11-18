/**
 * The AI assistant's `bash` tool: discovery commands run silently, anything else needs the person's
 * yes, credential reads and environment dumps are refused outright, the spawned process never sees a
 * secret-looking variable, and pi's own output cap keeps a flood of text bounded before the service
 * redacts it on the way to the model.
 *
 * `magic-action.ts` builds bash the same way for file actions; the env scrub (`isSecretKey`) and the
 * credential-name fence are shared through {@link scrubEnv} / {@link isAlwaysRefused} there.
 */

import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isSecretKey } from "../autorag-config-service";
import type { RunPrompter } from "./customizer-prompter";
import type { ReplyLanguage } from "./profiles/customizer-kit";

/** Files whose contents are credentials: never a subject of a shell command the assistant may run. */
export const CREDENTIAL_NAME =
	/^(?:\.env(?:\..*)?|id_[a-z0-9]+(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keychain-db)|(?:auth|models|mcp|mcp-auth|accounts)\.json|\.?credentials(?:\..*)?|\.netrc|\.npmrc|\.pypirc)$/iu;

/** The env names every spawned shell command's process must not carry. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretKey(key)));
}

/** Split a shell command the way the shell would run it, so each part can be judged on its own. */
function segments(command: string): readonly string[] {
	return command
		.split(/\|\||&&|;|\||\r?\n/gu)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

const SEGMENT_ALLOW: readonly RegExp[] = [
	/^which\s+\S+$/u,
	/^command\s+-v\s+\S+$/u,
	/^type\s+\S+$/u,
	/^\S+\s+(?:--version|-v|version|--help)$/u,
	/^uname(?:\s+-[A-Za-z]+)*$/u,
	/^sw_vers(?:\s+-[A-Za-z]+)*$/u,
	/^echo(?:\s+[^\s$][^$]*)?$/u,
	/^ls(?:\s+-[A-Za-z1]+)*(?:\s+[^\s$][^$]*)?$/u,
	/^npm\s+ls\s+-g\s+--depth=0$/u,
	/^brew\s+list$/u,
	/^pipx\s+list$/u,
];

/**
 * `2>/dev/null`, `>/dev/null 2>&1`, `&>/dev/null`: throwing a command's output away writes nothing, and a model adds it to almost
 * every lookup. Only the exact device counts (`/dev/nullx` or `/dev/null/../x` are real paths), and `2>&1` only after a discard.
 */
function stripDiscards(command: string): string {
	return command
		.replace(/(?:^|\s)(?:&|\d)?>{1,2}\s*\/dev\/null(?=\s|;|&|\||$)(?:\s+\d?>&\d)?/gu, " ")
		.replace(/\s{2,}/gu, " ");
}

/**
 * True when every segment is one of the read-only discovery commands: the shell runs it without asking.
 * A single segment that is anything else (or any shell metacharacter) makes the whole command need a confirmation.
 */
export function isAutoAllowed(command: string): boolean {
	if (command.trim().length === 0) return false;
	const withoutDiscards = stripDiscards(command);
	if (/[`$<>]/u.test(withoutDiscards)) return false;
	if (/\beval\b|\bsudo\b|\brm\b/u.test(command)) return false;
	if (/\|\s*(?:sh|bash|zsh|python|node)\b/u.test(command)) return false;
	const parts = segments(withoutDiscards);
	return parts.length > 0 && parts.every((part) => SEGMENT_ALLOW.some((pattern) => pattern.test(part)));
}

export interface GuardContext {
	readonly agentDir: string;
}

/** A credential-looking token: an argument whose filename is a credential, or a `.credentials*` path. */
function tokenLooksLikeCredential(token: string): boolean {
	const unquoted = token.replace(/^["']|["']$/gu, "");
	if (CREDENTIAL_NAME.test(unquoted.split("/").pop() ?? unquoted)) return true;
	return unquoted.includes(".credentials");
}

/**
 * Commands that are refused even when the person confirmed: printing the environment or reading a
 * credential file or the Dazzi sign-in directory. The assistant never gets these, confirmed or not.
 */
export function isAlwaysRefused(command: string, context: GuardContext): boolean {
	if (command.trim().length === 0) return false;
	const lower = command.toLowerCase();
	if (context.agentDir.length > 0 && command.includes(context.agentDir)) return true;
	if (command.includes("~/.pi/agent")) return true;
	for (const part of segments(command)) {
		const head = part.split(/\s+/u)[0] ?? "";
		if (head === "env" || head === "printenv" || head === "set") return true;
		if (/^export\s+-p\b/u.test(part) || /^declare\s+-x\b/u.test(part)) return true;
		for (const token of part.split(/\s+/u)) if (tokenLooksLikeCredential(token)) return true;
	}
	if (/\bsecurity\s+find-(?:generic|internet)-password\b/u.test(lower)) return true;
	if (/\bdefaults\s+read\b/u.test(lower) && /(keychain|login|credential|password|token|secret|apple\s+global)/u.test(lower)) return true;
	if (/\becho\b[^\n]*\$\{?[A-Za-z_]*(?:key|token|secret|password|passwd|credential)/iu.test(command)) return true;
	if (/\bprocess\.env\b|\bos\.environ\b|\$environ\b/u.test(command)) return true;
	return false;
}

export interface GuardedBashInput {
	readonly cwd: string;
	readonly homeDir: string;
	readonly agentDir: string;
	/** Extra variables to merge into the spawned env (after scrubbing). */
	readonly env: NodeJS.ProcessEnv;
	/** Where to ask the person to confirm a command that is neither auto-allowed nor refused; absent -> refuse. */
	readonly prompter?: () => RunPrompter | undefined;
	readonly language?: ReplyLanguage;
}

function confirmTitle(language: ReplyLanguage, command: string): string {
	switch (language) {
		case "en":
			return `Run this command?\n${command}`;
		case "ja":
			return `このコマンドを実行しますか？\n${command}`;
		case "zh":
			return `要运行此命令吗？\n${command}`;
		default:
			return `이 명령을 실행할까요?\n${command}`;
	}
}

/**
 * The `bash` tool. Builds pi's bash definition, then wraps its execution:
 * (c) always-refused first, then (b) auto-allowed, else the person's confirmation. (a) is the spawn hook.
 */
export function createGuardedBashTool(input: GuardedBashInput): ToolDefinition {
	const inner = createBashToolDefinition(input.cwd, {
		spawnHook: (ctx) => ({ ...ctx, env: scrubEnv({ ...ctx.env, ...input.env }) }),
	});
	const context: GuardContext = { agentDir: input.agentDir };
	const language = input.language ?? "ko";
	const execute = inner.execute as (...args: unknown[]) => Promise<unknown>;
	return {
		...inner,
		execute: async (...args: unknown[]) => {
			const params = (args[1] ?? {}) as { readonly command?: unknown };
			const command = typeof params.command === "string" ? params.command : "";
			if (isAlwaysRefused(command, context)) {
				throw new Error("Refused: this command would read a credential or print the environment; it is never run.");
			}
			if (!isAutoAllowed(command)) {
				const prompter = input.prompter?.();
				if (prompter === undefined) {
					throw new Error("Refused: running a command that is not a read-only discovery needs the person's confirmation, which is not available here.");
				}
				const answer = await prompter.askConfirm({ title: confirmTitle(language, command), lines: [command] });
				if (answer.kind !== "confirm" || !answer.confirmed) {
					throw new Error("The person declined to run this command.");
				}
			}
			return execute(...args);
		},
	} as unknown as ToolDefinition;
}
