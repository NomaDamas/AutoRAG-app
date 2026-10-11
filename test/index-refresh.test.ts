import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Librarian from "@autorag/librarian";
import { refreshAutoragIndex } from "../src/main/index-refresh";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("@autorag/librarian", async (importOriginal) => ({
	...(await importOriginal<typeof Librarian>()),
	AutoRAGLite: class {
		refresh = refresh;
	},
}));

const directories: string[] = [];

async function fixture(): Promise<{ readonly env: NodeJS.ProcessEnv; readonly cwd: string }> {
	const root = await mkdtemp(join(tmpdir(), "autorag-index-refresh-"));
	directories.push(root);
	const docs = join(root, "docs");
	await mkdir(docs, { recursive: true });
	const configPath = join(root, "config.json");
	await writeFile(configPath, JSON.stringify({ searchPaths: [docs], workspacePath: join(root, "workspace"), minSync: { enabled: true } }));
	return { env: { HOME: root, AUTORAG_CONFIG: configPath }, cwd: root };
}

function result(fsearch: unknown): unknown {
	return { scanned: 1, written: 1, deleted: 0, skipped: 0, diagnostics: [], minsync: { ok: true }, fsearch };
}

beforeEach(() => refresh.mockReset());
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("refreshAutoragIndex", () => {
	it("does not fail the refresh when the optional fsearch-cli is not installed", async () => {
		refresh.mockResolvedValue(result({ ok: false, reason: "binary-missing", message: "fsearch-cli: spawn fsearch-cli ENOENT" }));

		const outcome = await refreshAutoragIndex(await fixture());

		expect(outcome).toMatchObject({ ok: true, error: null });
	});

	it("still fails the refresh when fsearch-cli is installed but indexing fails", async () => {
		refresh.mockResolvedValue(result({ ok: false, reason: "index-failed", message: "database is locked" }));

		const outcome = await refreshAutoragIndex(await fixture());

		expect(outcome).toMatchObject({ ok: false, error: "fsearch: database is locked" });
	});
});
