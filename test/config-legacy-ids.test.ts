import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfigReadOnly } from "@autorag/librarian";
import { migrateLegacyProviderIds } from "../src/main/config-legacy-ids";

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function writeConfig(raw: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "autorag-legacy-ids-"));
	roots.push(root);
	const path = join(root, "config.json");
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
	return path;
}

const resolve = (path: string) => resolveConfigReadOnly({ flags: {}, env: { ...process.env, AUTORAG_CONFIG: path }, cwd: tmpdir() });

/** What an app build on librarian 2.10.1 wrote for a signed-in plan user. */
const legacyConfig = () => ({
	workspacePath: "/docs",
	searchPaths: ["/docs"],
	model: { provider: "autorag", id: "vendor/pricey", baseUrl: "http://plan.test/v1", apiKeyEnv: "AUTORAG_API_KEY" },
	queryDecomposition: { model: { provider: "autorag", id: "vendor/cheap", apiKeyEnv: "AUTORAG_API_KEY" } },
	jev: { backend: "autorag", model: "jev-1.13" },
	rerank: { enabled: true, provider: "autorag", model: "qwen/qwen3-reranker-8b", apiKeyEnv: "AUTORAG_API_KEY" },
	webSearch: { enabled: false },
});

describe("migrateLegacyProviderIds", () => {
	it("rewrites the four legacy values so the librarian resolves the config again", () => {
		const path = writeConfig(legacyConfig());
		// The regressions this migration exists for: 2.10.2 rejects the old
		// backend and every env-name leaf on a plan block.
		expect(() => resolve(path)).toThrow(/jev\.backend/);

		expect(migrateLegacyProviderIds(path)).toBe(true);

		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			model: Record<string, unknown>;
			queryDecomposition: { model: Record<string, unknown> };
			jev: Record<string, unknown>;
			rerank: Record<string, unknown>;
			webSearch: unknown;
		};
		const decomposition = raw.queryDecomposition;
		expect(raw.model.provider).toBe("dazzi");
		expect(decomposition.model.provider).toBe("dazzi");
		expect(raw.jev.backend).toBe("dazzi");
		expect(raw.rerank.provider).toBe("dazzi");
		// The credential moved to Pi's `auth.json`; the env-name leaves are gone.
		expect("apiKeyEnv" in raw.model).toBe(false);
		expect("apiKeyEnv" in decomposition.model).toBe(false);
		expect("apiKeyEnv" in raw.rerank).toBe(false);
		expect(raw.model.id).toBe("vendor/pricey");
		expect(decomposition.model.id).toBe("vendor/cheap");
		expect(raw.jev.model).toBe("jev-1.13");
		expect(raw.rerank.model).toBe("qwen/qwen3-reranker-8b");
		expect(raw.webSearch).toEqual({ enabled: false });
		expect(() => resolve(path)).not.toThrow();
		expect(resolve(path).model?.provider).toBe("dazzi");
	});

	it("leaves a config without legacy values byte-identical", () => {
		const path = writeConfig({ ...legacyConfig(), model: { provider: "dazzi", id: "x" }, queryDecomposition: false, jev: { backend: "openrouter" }, rerank: { provider: "openrouter", model: "voyageai/rerank-3-lite" } });
		const before = readFileSync(path, "utf8");

		expect(migrateLegacyProviderIds(path)).toBe(false);

		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("never touches a `queryDecomposition: false` or a `jev: false` block", () => {
		const path = writeConfig({ ...legacyConfig(), queryDecomposition: false, jev: false });

		migrateLegacyProviderIds(path);

		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		expect(raw.queryDecomposition).toBe(false);
		expect(raw.jev).toBe(false);
		expect((raw.model as Record<string, unknown>).provider).toBe("dazzi");
		expect((raw.rerank as Record<string, unknown>).provider).toBe("dazzi");
	});
});
