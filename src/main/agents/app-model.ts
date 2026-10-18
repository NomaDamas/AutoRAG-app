import { resolveConfigReadOnly, type CliConfig } from "@autorag/librarian";
import { resolveAgentModel } from "@autorag/librarian/core";
import { applyDazziThinkingLevels, openPlanRuntime, preferPlanOAuth } from "../dazzi-session-auth";
import type { ProfileModel } from "./agent-factory";

/**
 * The model every agent in the app runs on: the one the shared AutoRAG config
 * names for the AutoRAG agent, with its credentials. AI Search and the profile
 * agents both resolve it here, so there is one answer to "which model, which key".
 *
 * Credentials are read fresh on every call, so a login or key change reaches the
 * next session without a restart. The signed-in plan authenticates through its
 * stored OAuth credential, so its API key is dropped from the result
 * (see dazzi-session-auth.ts).
 */
export async function resolveSessionModel(config: CliConfig, env: NodeJS.ProcessEnv, cwd: string, agentDir: string): Promise<ProfileModel> {
	const resolved = await preferPlanOAuth(await resolveAgentModel(config, { env, cwd }), () => openPlanRuntime(agentDir, env));
	return { ...resolved, model: applyDazziThinkingLevels(resolved.model) };
}

/** {@link resolveSessionModel} for the config file the app and the CLI share. */
export function resolveAppSessionModel(env: NodeJS.ProcessEnv, cwd: string, agentDir: string): Promise<ProfileModel> {
	return resolveSessionModel(resolveConfigReadOnly({ flags: {}, env, cwd }), env, cwd, agentDir);
}
