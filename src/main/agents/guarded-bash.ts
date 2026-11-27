/**
 * The Settings assistants' `bash` tool.
 *
 * Settings assistants run with full read/write shell access (matching librarian v2.15's
 * simplified permission model — no Jev write-classification gate or per-path write fence).
 *
 * Two things still keep secrets out of the model's context without limiting what the
 * assistant can inspect or change: the spawned process never inherits secret-looking
 * variables from the app's own environment (`scrubEnv`), and every tool result passes
 * through `guardTools`, which redacts known secrets and credential-shaped strings.
 */

import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isSecretKey } from "../autorag-config-service";

/** The env names a spawned shell command's process must not carry. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretKey(key)));
}

export interface GuardedBashInput {
	readonly cwd: string;
	/** Extra variables to merge into the spawned env (after scrubbing). */
	readonly env: NodeJS.ProcessEnv;
}

/** pi's bash tool with secret env variables scrubbed from the spawned child process. */
export function createGuardedBashTool(input: GuardedBashInput): ToolDefinition {
	return createBashToolDefinition(input.cwd, {
		spawnHook: (ctx) => ({ ...ctx, env: scrubEnv({ ...ctx.env, ...input.env }) }),
	}) as unknown as ToolDefinition;
}
