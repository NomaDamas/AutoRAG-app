import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ParsedMirrorEntry } from "@autorag/librarian";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMirrorStage } from "./support/seed-mirror-stage";
import type * as Librarian from "@autorag/librarian";
import { existsSync, readFileSync } from "node:fs";
import { MailcrawlClient } from "@autorag/librarian";
import { refreshAutoragIndex } from "../src/main/index-refresh";
import { t } from "../src/shared/i18n/core";

const refresh = vi.hoisted(() => vi.fn());
const syncMinSync = vi.hoisted(() => vi.fn());
const batches = vi.hoisted((): Array<number | undefined> => []);
const excludes = vi.hoisted((): Array<readonly string[]> => []);
const datasourceConfigs = vi.hoisted((): Array<unknown> => []);
const modelMissing = vi.hoisted(() => ({ value: false }));

vi.mock("../src/main/embedding-daemon", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/main/embedding-daemon")>()),
	localModelMissing: () => modelMissing.value,
}));

vi.mock("@autorag/librarian", async (importOriginal) => ({
	...(await importOriginal<typeof Librarian>()),
	AutoRAGLite: class {
		constructor(config: { minSync?: { embedder?: { batchSize?: number } }; excludePaths?: readonly string[]; datasources?: unknown }) {
			datasourceConfigs.push(config.datasources);
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
	datasourceConfigs.length = 0;
	modelMissing.value = false;
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

		it("halves the batch when MinSync 0.4.8 skips a timed-out file on a partial sync (exit 6) and clears the superseded skip", async () => {
			const partialTimeout = {
				scanned: 2,
				written: 2,
				deleted: 0,
				skipped: 0,
				diagnostics: [
					{
						code: "minsync-file-skipped",
						severity: "warning",
						source: "files/large.md",
						message: `MinSync skipped this file at the embed stage and will retry it on the next sync: ${timeoutMessage}`,
					},
				],
				minsync: { ok: true, synced: 1 },
			};
			refresh.mockResolvedValueOnce(partialTimeout);
			syncMinSync
				.mockResolvedValueOnce({
					ok: true,
					synced: 0,
					filesFailed: [{ path: "files/large.md", stage: "embed", error: timeoutMessage }],
				})
				.mockResolvedValueOnce({
					ok: true,
					synced: 1,
					filesFailed: [{ path: "files/unreadable.md", stage: "read", error: "Permission denied" }],
				});
			const deps = await fixture();

			const outcome = await refreshAutoragIndex(deps);

			expect(outcome).toMatchObject({ ok: true, error: null });
			expect(batches).toEqual([undefined, 32, 16]);
			expect(JSON.parse(readFileSync(learnedFile(deps), "utf8"))).toEqual({ local: 16 });
			expect(outcome.diagnostics).toEqual([
				{
					code: "minsync-file-skipped",
					severity: "warning",
					message: "MinSync skipped this file at the read stage and will retry it on the next sync: Permission denied",
				},
			]);
		});

		it("halves the batch when the native embedder exceeds its per-batch deadline (exit 7)", async () => {
			const nativeDeadlineMessage = "embedder timeout: files/huge.md: native embedding batch exceeded 60s; its thread cannot be cancelled — re-run `minsync sync` to resume";
			const nativeTimeout = {
				...timeout,
				diagnostics: [{ code: "minsync-sync-failed", severity: "error", source: "minsync", message: nativeDeadlineMessage }],
				minsync: { ok: false, synced: 0, reason: "sync-failed", diagnostics: [{ code: "minsync-sync-failed", severity: "error", source: "minsync", message: nativeDeadlineMessage }] },
			};
			refresh.mockResolvedValueOnce(nativeTimeout);
			syncMinSync.mockResolvedValueOnce(fits);
			const deps = await fixture();

			const outcome = await refreshAutoragIndex(deps);

			expect(outcome).toMatchObject({ ok: true, error: null });
			expect(batches).toEqual([undefined, 32]);
			expect(JSON.parse(readFileSync(learnedFile(deps), "utf8"))).toEqual({ local: 32 });
		});

		it("does not shrink or remember a smaller batch when a skipped file merely has 413 in its name", async () => {
			const unrelatedSkip = {
				scanned: 2,
				written: 2,
				deleted: 0,
				skipped: 0,
				diagnostics: [
					{
						code: "minsync-file-skipped",
						severity: "warning",
						source: "files/invoice-413.md",
						message: "MinSync skipped this file at the embed stage and will retry it on the next sync: files/invoice-413.md: embedding failed: non-finite values",
					},
				],
				minsync: { ok: true, synced: 1 },
			};
			refresh.mockResolvedValueOnce(unrelatedSkip);
			const deps = await fixture();

			const outcome = await refreshAutoragIndex(deps);

			expect(outcome.ok).toBe(true);
			expect(syncMinSync).not.toHaveBeenCalled();
			expect(batches).toEqual([undefined]);
			expect(existsSync(learnedFile(deps))).toBe(false);
			expect(outcome.diagnostics).toEqual([
				expect.objectContaining({ code: "minsync-file-skipped", message: expect.stringContaining("invoice-413.md") }),
			]);
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
	seedMirrorStage(join(root, "workspace"), { version: 1, entries, skipped: {} });
}

describe("refreshAutoragIndex against unreliable folders and files", () => {
	it("refuses to refresh, and deletes nothing, when a folder that was full now lists as empty", async () => {
		const setup = await fixture();
		seedIndex(setup.cwd, 30);

		const outcome = await refreshAutoragIndex(setup);

		expect(outcome).toMatchObject({ ok: false, deleted: 0 });
		expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["search-root-unavailable"]);
		expect(outcome.diagnostics[0]?.folders).toEqual([expect.stringContaining("docs")]);
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
		expect(outcome.diagnostics.find((diagnostic) => diagnostic.code === "files-left-out")?.count).toBe(1);
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

describe("refreshAutoragIndex while the on-device model is not downloaded", () => {
	it("stops with a message that points at the download instead of letting MinSync fetch 1.2 GB itself", async () => {
		modelMissing.value = true;

		const outcome = await refreshAutoragIndex(await fixture());

		expect(refresh).not.toHaveBeenCalled();
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBe(t("main.refresh.modelMissing"));
		expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: "embedding-model-missing", severity: "error" })]);
	});

	it("still refreshes keyword-only, which needs no model", async () => {
		modelMissing.value = true;
		refresh.mockResolvedValue({ scanned: 1, written: 1, deleted: 0, skipped: 0, diagnostics: [] });
		const setup = await fixture();
		const path = setup.env.AUTORAG_CONFIG as string;
		await writeFile(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), appIndexing: { semanticSearch: false } }));

		const outcome = await refreshAutoragIndex(setup);

		expect(outcome.ok).toBe(true);
		expect(refresh).toHaveBeenCalled();
	});
});

describe("refreshAutoragIndex in keyword-only mode (appIndexing.semanticSearch: false)", () => {
	async function keywordOnly(): Promise<{ readonly env: NodeJS.ProcessEnv; readonly cwd: string }> {
		const setup = await fixture();
		const path = setup.env.AUTORAG_CONFIG as string;
		const raw = JSON.parse(readFileSync(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...raw, appIndexing: { semanticSearch: false }, datasources: { slack: { type: "slack" } } }));
		return setup;
	}

	it("runs the parsed mirror and Jikji instead of MinSync, and never calls MinSync", async () => {
		refresh.mockResolvedValue({ scanned: 1, written: 1, deleted: 0, skipped: 0, diagnostics: [] });

		const outcome = await refreshAutoragIndex(await keywordOnly());

		expect(refresh).toHaveBeenCalledWith(false, { methods: ["parsed", "jikji"] });
		expect(syncMinSync).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ ok: true, error: null, methods: ["parsed", "jikji"] });
	});

	it("hands the librarian datasources whose semantic half is off", async () => {
		refresh.mockResolvedValue({ scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [] });

		await refreshAutoragIndex(await keywordOnly(), ["datasources"]);

		expect(datasourceConfigs.at(-1)).toEqual({ slack: { type: "slack", connector: { sidecar: { semantic: false } } } });
	});

	it("disables the datasource embedding steps only while the refresh runs", async () => {
		const realIndex = MailcrawlClient.prototype.index;
		let during: unknown;
		refresh.mockImplementation(async () => {
			during = MailcrawlClient.prototype.index;
			return { scanned: 0, written: 0, deleted: 0, skipped: 0, diagnostics: [] };
		});

		await refreshAutoragIndex(await keywordOnly(), ["datasources"]);

		expect(during).not.toBe(realIndex);
		expect(MailcrawlClient.prototype.index).toBe(realIndex);
	});

	it("keeps MinSync in the default refresh when semantic search is on", async () => {
		refresh.mockResolvedValue(result(undefined));

		await refreshAutoragIndex(await fixture());

		expect(refresh).toHaveBeenCalledWith(false, { methods: ["parsed", "minsync"] });
		expect(datasourceConfigs.at(-1)).toBeUndefined();
	});
});

describe("refreshAutoragIndex embedder preflight", () => {
	async function remoteFixture(embedder: Record<string, unknown>): Promise<{ readonly env: NodeJS.ProcessEnv; readonly cwd: string }> {
		const root = await mkdtemp(join(tmpdir(), "autorag-index-refresh-"));
		directories.push(root);
		const docs = join(root, "docs");
		await mkdir(docs, { recursive: true });
		const configPath = join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ searchPaths: [docs], workspacePath: join(root, "workspace"), minSync: { enabled: true, embedder } }));
		return { env: { HOME: root, AUTORAG_CONFIG: configPath }, cwd: root };
	}
	const remote = { id: "openai:acme/embed-small", baseUrl: "https://gateway.example/api/v1", dimension: 3, apiKeyEnv: "OPENAI_API_KEY" };

	it("fails with the embedder's own reason, and never starts parsing, when the embedder is unusable", async () => {
		const preflightFetch = vi.fn(async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
		vi.stubEnv("OPENAI_API_KEY", "sk-test");

		const outcome = await refreshAutoragIndex({ ...(await remoteFixture(remote)), preflightFetch });

		expect(outcome).toMatchObject({ ok: false, scanned: 0, written: 0 });
		expect(outcome.error).toContain("/v1");
		expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: "embedder-preflight-failed", severity: "error", reason: "base-url-v1" })]);
		expect(refresh).not.toHaveBeenCalled();
		expect(syncMinSync).not.toHaveBeenCalled();
		vi.unstubAllEnvs();
	});

	it("runs the refresh when the embedder answers", async () => {
		const preflightFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 })) as unknown as typeof fetch;
		vi.stubEnv("OPENAI_API_KEY", "sk-test");
		refresh.mockResolvedValue(result(undefined));

		const outcome = await refreshAutoragIndex({ ...(await remoteFixture({ ...remote, baseUrl: "https://gateway.example/api" })), preflightFetch });

		expect(outcome).toMatchObject({ ok: true, error: null });
		expect(refresh).toHaveBeenCalledTimes(1);
		vi.unstubAllEnvs();
	});

	it("does not probe a refresh that never reaches MinSync", async () => {
		const preflightFetch = vi.fn() as unknown as typeof fetch;
		refresh.mockResolvedValue(result(undefined));

		await refreshAutoragIndex({ ...(await remoteFixture(remote)), preflightFetch }, ["parsed"]);

		expect(preflightFetch).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
