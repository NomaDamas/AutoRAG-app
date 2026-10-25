import { describe, expect, it } from "vitest";
import { classifyIndexFailure, isDiskFull, skippedFileCount } from "../src/main/index-failure";
import { failureKind } from "../src/shared/index-failure";
import type { ConfigRefreshDiagnostic } from "../src/shared/settings-contract";

const diag = (code: string, extra: Partial<ConfigRefreshDiagnostic> = {}): ConfigRefreshDiagnostic => ({
	code,
	severity: "error",
	message: `message for ${code}`,
	...extra,
});

const classify = (diagnostics: readonly ConfigRefreshDiagnostic[], error: string | null = "x") => classifyIndexFailure({ diagnostics, error });

describe("classifyIndexFailure", () => {
	it("names the unreadable folders when a search root is unavailable", () => {
		expect(classify([diag("search-root-unavailable", { folders: ["/Volumes/Work/Projects"] })])).toEqual({
			reason: "folder-unreadable",
			folders: ["/Volumes/Work/Projects"],
			code: "search-root-unavailable",
		});
	});

	it.each(["unreachable", "timeout", "server-error"])("treats a preflight that never got an answer (%s) as the embedder being offline", (reason) => {
		expect(classify([diag("embedder-preflight-failed", { reason })]).reason).toBe("embedder-offline");
	});

	it.each(["missing-key", "key-env-ignored", "base-url-v1", "rejected", "no-vector", "dimension"])(
		"treats a preflight the embedder answered with a refusal (%s) as a setting to change",
		(reason) => {
			const failure = classify([diag("embedder-preflight-failed", { reason })]);
			expect(failure.reason).toBe("embedder-config");
			expect(failure.code).toBe("embedder-preflight-failed");
		},
	);

	it("treats a preflight failure without a reason as a setting to change", () => {
		expect(classify([diag("embedder-preflight-failed")]).reason).toBe("embedder-config");
	});

	it("separates a full disk from any other failed model download", () => {
		expect(classify([diag("embedding-model-download-failed", { reason: "disk-full" })]).reason).toBe("disk-full");
		expect(classify([diag("embedding-model-download-failed", { reason: "network" })]).reason).toBe("model-download");
	});

	it("treats a missing local model as a download to repeat", () => {
		expect(classify([diag("embedding-model-missing")]).reason).toBe("model-download");
	});

	it("treats an embedding batch that timed out as the embedder being offline", () => {
		expect(classify([diag("sync-failed", { message: "embedding upstream timed out after 30000ms" })]).reason).toBe("embedder-offline");
		expect(classify([], "minsync: embedding upstream timed out after 30000ms").reason).toBe("embedder-offline");
	});

	it("leaves an embedder that is merely 'unavailable' unknown rather than guessing a cause", () => {
		const failure = classify(
			[diag("embedder-unavailable", { message: "check-failed: embedder unavailable" })],
			"minsync: check-failed: embedder unavailable; check-failed: embedder unavailable",
		);
		expect(failure).toEqual({ reason: "unknown", folders: [], code: "embedder-unavailable" });
	});

	it("reads a full disk out of an error that carries no diagnostic", () => {
		expect(classify([], "ENOSPC: no space left on device, write")).toEqual({ reason: "disk-full", folders: [], code: null });
	});

	it("is unknown when nothing says what happened", () => {
		expect(classify([], null)).toEqual({ reason: "unknown", folders: [], code: null });
	});

	it("keeps a warning from deciding the reason", () => {
		expect(classify([diag("embedder-preflight-failed", { severity: "warning", reason: "rejected" })], null).reason).toBe("unknown");
	});

	it("lets an unavailable root outrank an embedder problem, because nothing can be read at all", () => {
		const failure = classify([diag("embedder-preflight-failed", { reason: "rejected" }), diag("search-root-unavailable", { folders: ["/a"] })]);
		expect(failure.reason).toBe("folder-unreadable");
		expect(failure.folders).toEqual(["/a"]);
	});
});

describe("failureKind", () => {
	it("groups reasons into the kinds the screens are designed for", () => {
		expect(failureKind("embedder-config")).toBe("config");
		expect(failureKind("embedder-offline")).toBe("transient");
		expect(failureKind("model-download")).toBe("transient");
		expect(failureKind("disk-full")).toBe("environment");
		expect(failureKind("folder-unreadable")).toBe("environment");
		expect(failureKind("unknown")).toBe("unknown");
	});
});

describe("skippedFileCount", () => {
	it("adds up the files each warning says it left out; a skipped-file warning is one file", () => {
		const diagnostics = [
			diag("files-left-out", { severity: "warning", count: 7 }),
			diag("parse-killed", { severity: "warning", count: 3 }),
			diag("minsync-file-skipped", { severity: "warning" }),
			diag("minsync-file-skipped", { severity: "warning" }),
		];
		expect(skippedFileCount(diagnostics)).toBe(12);
	});

	it("ignores warnings that skip nothing and counts that are missing", () => {
		const diagnostics = [diag("refresh-retried", { severity: "warning" }), diag("files-left-out", { severity: "warning" }), diag("minsync-stalled-retried", { severity: "warning", count: 4 })];
		expect(skippedFileCount(diagnostics)).toBe(0);
	});
});

describe("isDiskFull", () => {
	it("recognises Node's errno name and nothing looser", () => {
		expect(isDiskFull("fetch failed (ENOSPC: no space left on device, write)")).toBe(true);
		expect(isDiskFull("the disk is full")).toBe(false);
		expect(isDiskFull(null)).toBe(false);
	});
});
