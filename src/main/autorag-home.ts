import { join, resolve } from "node:path";

/** The variables that choose the AutoRAG home and config file. */
type HomeEnv = Readonly<Record<string, string | undefined>>;

/**
 * The librarian's operator home: `AUTORAG_HOME` when set, `<homeDir>/.autorag` otherwise.
 *
 * This repeats the librarian's `resolveAutoRAGHome` on purpose: the fs worker reads it for the sidebar and
 * must not load `@autorag/librarian` (test/fs-worker-no-librarian.test.ts). test/autorag-home.test.ts pins
 * the rule.
 */
export function autoragHome(env: HomeEnv, homeDir: string): string {
	const configured = env.AUTORAG_HOME?.trim();
	return configured === undefined || configured.length === 0 ? join(homeDir, ".autorag") : resolve(configured);
}

/** The AutoRAG config file: `AUTORAG_CONFIG` as written, else `config.json` in the AutoRAG home. */
export function autoragConfigPath(env: HomeEnv, homeDir: string): string {
	const configured = env.AUTORAG_CONFIG;
	return configured !== undefined && configured.length > 0 ? configured : join(autoragHome(env, homeDir), "config.json");
}
