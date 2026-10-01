import { existsSync } from "node:fs";
import { resolveConfigReadOnly } from "@autorag/librarian";
import { resolveAgentModelDetailed, resolveConfigPath } from "@autorag/librarian/core";
import type { ConfiguredModel, ConfiguredModelSnapshot, ModelResolutionSource } from "../shared/settings-contract";

/**
 * Settings > Models reads the shared AutoRAG config — the same file the CLI,
 * TUI, serve, and every app agent resolve — on each call, and reports the
 * provider/model the librarian's own resolver would hand the agent. The app
 * never keeps a copy, so a model edit from any AutoRAG surface shows up here.
 */
export interface ModelStatusService {
	resolve(): Promise<ConfiguredModelSnapshot>;
}

export interface ModelStatusDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
}

export function createModelStatusService(deps: ModelStatusDeps): ModelStatusService {
	return {
		resolve: async () => {
			const configPath = resolveConfigPath({ flags: {}, env: deps.env, cwd: deps.cwd }).configPath;
			const snapshot: ConfiguredModelSnapshot = {
				configPath,
				configExists: existsSync(configPath),
				error: null,
				model: null,
			};
			try {
				const config = resolveConfigReadOnly({ flags: {}, env: deps.env, cwd: deps.cwd });
				const { role } = resolveAgentModelDetailed(config, { env: deps.env });
				const model: ConfiguredModel = {
					provider: role.provider,
					modelId: role.modelId,
					displayName: role.displayName,
					api: role.api,
					baseUrl: role.baseUrl ?? null,
					resolutionSource: role.resolutionSource as ModelResolutionSource,
					auth: {
						present: role.auth.present,
						source: role.auth.source,
						envName: role.auth.envName ?? null,
					},
				};
				return { ...snapshot, model };
			} catch (error) {
				return { ...snapshot, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
