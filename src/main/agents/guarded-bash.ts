/**
 * The AI assistant's `bash` tool.
 *
 * Reading is free: the assistant may look at any file, list any folder and run any lookup, because finding another coding agent's
 * config is exactly what it is for. Changing things is not: a command runs only when Jev (the same decision model that gates the
 * AutoRAG agent's file changes) judges that it touches nothing but the files this profile manages; see `write-gate.ts`.
 *
 * Two things keep a secret out of the model's context without limiting what it can look at: the spawned process never gets a
 * secret-looking variable of the app's own, and every result passes through `guardTools`, which removes the values the app knows
 * (see `known` below) and anything shaped like a credential.
 */

import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isSecretKey } from "../autorag-config-service";
import { createWriteGate, type WriteJudge } from "./write-gate";

/** The env names a spawned shell command's process must not carry. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretKey(key)));
}

export interface GuardedBashInput {
	readonly cwd: string;
	readonly homeDir: string;
	/** Extra variables to merge into the spawned env (after scrubbing). */
	readonly env: NodeJS.ProcessEnv;
	/** The files this profile manages: the only ones a command may change. */
	readonly managedPaths: readonly string[];
	/** A new `export NAME=value` line appended to a shell profile counts as managed. */
	readonly allowEnvVars: boolean;
	/** Jev; undefined when no decision model is configured, in which case only plainly read-only commands and managed writes run. */
	readonly judge: WriteJudge | undefined;
}

/** pi's bash, behind the write gate. */
export function createGuardedBashTool(input: GuardedBashInput): ToolDefinition {
	const inner = createBashToolDefinition(input.cwd, {
		spawnHook: (ctx) => ({ ...ctx, env: scrubEnv({ ...ctx.env, ...input.env }) }),
	});
	const gate = createWriteGate({ cwd: input.cwd, homeDir: input.homeDir, managedPaths: input.managedPaths, allowEnvVars: input.allowEnvVars, judge: input.judge });
	const execute = inner.execute as (...args: unknown[]) => Promise<unknown>;
	return {
		...inner,
		description: `${inner.description} Reading is unrestricted. Commands that change files run only when they change nothing but the files this assistant manages${input.allowEnvVars ? " (plus a new environment variable line in the shell profile)" : ""}.`,
		execute: async (...args: unknown[]) => {
			const params = (args[1] ?? {}) as { readonly command?: unknown };
			const command = typeof params.command === "string" ? params.command : "";
			const verdict = await gate.check({ command });
			if (!verdict.allowed) throw new Error(verdict.reason ?? "Refused.");
			return execute(...args);
		},
	} as unknown as ToolDefinition;
}
