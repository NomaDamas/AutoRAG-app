import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Librarian from "@autorag/librarian";
import { readFileSync } from "node:fs";
import { refreshAutoragIndex } from "../src/main/index-refresh";

const refresh = vi.hoisted(() => vi.fn());
const batches = vi.hoisted((): Array<number | undefined> => []);

vi.mock("@autorag/librarian", async (importOriginal) => ({
	...(await importOriginal<typeof Librarian>()),
	AutoRAGLite: class {
		constructor(config: { minSync?: { embedder?: { batchSize?: number } } }) {
			batches.push(config.minSync?.embedder?.batchSize);
		}
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

beforeEach(() => {
	refresh.mockReset();
	batches.length = 0;
});
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

	describe("embedding timeouts", () => {
		const timeout = {
			scanned: 1,
			written: 1,
			deleted: 0,
			skipped: 0,
			diagnostics: [{ code: "minsync-sync-failed", severity: "error", message: 'TEI API error 504 Gateway Timeout: {"code":"timeout"}' }],
			minsync: { ok: false, reason: "sync-failed" },
		};
		const fits = { scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [], minsync: { ok: true } };

		it("halves the batch after each timeout, succeeds, and remembers the size for the local embedder", async () => {
			refresh.mockResolvedValueOnce(timeout).mockResolvedValueOnce(timeout).mockResolvedValueOnce(fits);
			const deps = await fixture();

			const outcome = await refreshAutoragIndex(deps);

			expect(outcome).toMatchObject({ ok: true, error: null });
			expect(batches).toEqual([undefined, 32, 16]);
			expect(refresh.mock.calls.map((call) => (call[1] as { methods: string[] }).methods)).toEqual([["parsed", "minsync"], ["minsync"], ["minsync"]]);
			const stored = JSON.parse(readFileSync(deps.env.AUTORAG_CONFIG as string, "utf8"));
			expect(stored.appIndexing.embeddingBatchSize).toEqual({ local: 16 });
		});

		it("starts the next refresh at the remembered size", async () => {
			refresh.mockResolvedValueOnce(timeout).mockResolvedValueOnce(fits).mockResolvedValueOnce(fits);
			const deps = await fixture();
			await refreshAutoragIndex(deps);
			batches.length = 0;

			await refreshAutoragIndex(deps);

			expect(batches).toEqual([32]);
		});

		it("does not shrink for a failure that is not a timeout", async () => {
			refresh.mockResolvedValue({ ...timeout, diagnostics: [{ code: "minsync-sync-failed", severity: "error", message: "model file is missing" }] });

			const outcome = await refreshAutoragIndex(await fixture());

			expect(outcome.ok).toBe(false);
			expect(refresh).toHaveBeenCalledTimes(1);
		});

		it("gives up at a batch of one and reports the failure", async () => {
			refresh.mockResolvedValue(timeout);

			const outcome = await refreshAutoragIndex(await fixture());

			expect(outcome.ok).toBe(false);
			expect(batches).toEqual([undefined, 32, 16, 8, 4, 2, 1]);
		});
	});
});
