import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { saveMirrorIndex, type ParsedMirrorEntry } from "@autorag/librarian";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Librarian from "@autorag/librarian";
import { existsSync, readFileSync } from "node:fs";
import { refreshAutoragIndex } from "../src/main/index-refresh";

const refresh = vi.hoisted(() => vi.fn());
const syncMinSync = vi.hoisted(() => vi.fn());
const batches = vi.hoisted((): Array<number | undefined> => []);
const excludes = vi.hoisted((): Array<readonly string[]> => []);

vi.mock("@autorag/librarian", async (importOriginal) => ({
	...(await importOriginal<typeof Librarian>()),
	AutoRAGLite: class {
		constructor(config: { minSync?: { embedder?: { batchSize?: number } }; excludePaths?: readonly string[] }) {
			batches.push(config.minSync?.embedder?.batchSize);
			excludes.push(config.excludePaths ?? []);
		}
		refresh = refresh;
		syncMinSync = syncMinSync;
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
	syncMinSync.mockReset();
	batches.length = 0;
	excludes.length = 0;
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
		const timeoutMessage = 'TEI API error 504 Gateway Timeout: {"code":"timeout"}';
		const timeout = {
			scanned: 1,
			written: 1,
			deleted: 0,
			skipped: 0,
			diagnostics: [{ code: "minsync-sync-failed", severity: "error", source: "minsync", message: timeoutMessage }],
			minsync: { ok: false, synced: 0, reason: "sync-failed", diagnostics: [{ code: "minsync-sync-failed", severity: "error", source: "minsync", message: timeoutMessage }] },
		};
		const failed = { ok: false, synced: 0, reason: "sync-failed", diagnostic: { code: "sync-failed", message: timeoutMessage } };
		const fits = { ok: true, synced: 3 };
		const learnedFile = (deps: { env: NodeJS.ProcessEnv }): string => join(deps.env.HOME as string, "embedding-batch.json");

		it("halves the batch with MinSync-only retries, succeeds, and remembers the local size", async () => {
			refresh.mockResolvedValueOnce(timeout);
			syncMinSync.mockResolvedValueOnce(failed).mockResolvedValueOnce(fits);
			const deps = await fixture();

			const outcome = await refreshAutoragIndex(deps);

			expect(outcome).toMatchObject({ ok: true, error: null });
			expect(outcome.diagnostics).toEqual([]);
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(batches).toEqual([undefined, 32, 16]);
			expect(JSON.parse(readFileSync(learnedFile(deps), "utf8"))).toEqual({ local: 16 });
			expect(JSON.parse(readFileSync(deps.env.AUTORAG_CONFIG as string, "utf8")).appIndexing).toBeUndefined();
		});

		it("starts the next refresh at the remembered size", async () => {
			refresh.mockResolvedValueOnce(timeout).mockResolvedValueOnce({ ...timeout, minsync: { ok: true, synced: 1 }, diagnostics: [] });
			syncMinSync.mockResolvedValueOnce(fits);
			const deps = await fixture();
			await refreshAutoragIndex(deps);
			batches.length = 0;

			await refreshAutoragIndex(deps);

			expect(batches).toEqual([32]);
		});

		it("does not shrink for a failure that is not a gateway timeout", async () => {
			const unavailable = { code: "embedder-unavailable", severity: "error", source: "minsync", message: "Embedding runtime did not become ready within 60000ms: health check timed out" };
			refresh.mockResolvedValue({ ...timeout, diagnostics: [unavailable], minsync: { ok: false, synced: 0, reason: "embedder-unavailable", diagnostics: [unavailable] } });

			const outcome = await refreshAutoragIndex(await fixture());

			expect(outcome.ok).toBe(false);
			expect(syncMinSync).not.toHaveBeenCalled();
		});

		it("gives up at a batch of one and reports the failure without remembering anything", async () => {
			refresh.mockResolvedValue(timeout);
			syncMinSync.mockResolvedValue(failed);
			const deps = await fixture();

			const outcome = await refreshAutoragIndex(deps);

			expect(outcome.ok).toBe(false);
			expect(batches).toEqual([undefined, 32, 16, 8, 4, 2, 1]);
			expect(existsSync(learnedFile(deps))).toBe(false);
		});
	});
});

/** Records that the previous refresh indexed `count` documents from `<root>/docs`. */
function seedIndex(root: string, count: number): void {
	const entries: Record<string, ParsedMirrorEntry> = {};
	for (let index = 0; index < count; index += 1) {
		const sourcePath = join(root, "docs", `n${index}.md`);
		entries[`/docs/n${index}.md`] = { virtualPath: `/docs/n${index}.md`, sourcePath, outputPath: join(root, "workspace", `n${index}.md`), parserName: "plain-text", sourceMtimeNs: 1, sourceSizeBytes: 1, updatedAt: new Date(0).toISOString() };
	}
	saveMirrorIndex(join(root, "workspace"), { version: 1, entries, skipped: {} });
}

describe("refreshAutoragIndex against unreliable folders and files", () => {
	it("refuses to refresh, and deletes nothing, when a folder that was full now lists as empty", async () => {
		const setup = await fixture();
		seedIndex(setup.cwd, 30);

		const outcome = await refreshAutoragIndex(setup);

		expect(outcome).toMatchObject({ ok: false, deleted: 0 });
		expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["search-root-unavailable"]);
		expect(outcome.error).toContain("30");
		expect(refresh).not.toHaveBeenCalled();
	});

	it("refreshes when the folder has files", async () => {
		const setup = await fixture();
		seedIndex(setup.cwd, 30);
		await writeFile(join(setup.cwd, "docs", "a.md"), "x");
		refresh.mockResolvedValue(result(undefined));

		expect(await refreshAutoragIndex(setup)).toMatchObject({ ok: true });
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("does not look at folders for a refresh that cannot delete mirrors", async () => {
		const setup = await fixture();
		seedIndex(setup.cwd, 30);
		refresh.mockResolvedValue(result(undefined));

		expect(await refreshAutoragIndex(setup, ["fsearch"])).toMatchObject({ ok: true });
	});

	it("leaves a file that the OS keeps refusing to read out of the run, and says so", async () => {
		const setup = await fixture();
		const locked = join(setup.cwd, "docs", "locked.docx");
		const busy = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY", path: locked });
		refresh.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValue(result(undefined));
		await writeFile(join(setup.cwd, "docs", "a.md"), "x");

		const outcome = await refreshAutoragIndex({ ...setup, recoveryBackoffMs: [0, 0] });

		expect(outcome.ok).toBe(true);
		expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain("files-left-out");
		expect(excludes.at(-1)).toContain(locked);
		expect(excludes[0]).not.toContain(locked);
	});

	it("reports a full disk as the failure it is instead of retrying it", async () => {
		const setup = await fixture();
		refresh.mockRejectedValue(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
		await writeFile(join(setup.cwd, "docs", "a.md"), "x");

		const outcome = await refreshAutoragIndex(setup);

		expect(outcome).toMatchObject({ ok: false, error: "ENOSPC: no space left on device" });
		expect(refresh).toHaveBeenCalledOnce();
	});
});
