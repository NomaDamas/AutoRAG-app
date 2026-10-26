import { describe, expect, it } from "vitest";
import { pauseExits, pauseLine, pauseSpec, type PauseHistory } from "../src/renderer/src/onboarding/pause";
import { INDEX_FAILURE_REASONS, type IndexFailure, type IndexFailureReason } from "../src/shared/index-failure";

const failure = (reason: IndexFailureReason, folders: readonly string[] = []): IndexFailure => ({ reason, folders, code: null });
const fresh: PauseHistory = { manualRepeats: 0, autoAttempts: 0 };

describe("pauseSpec", () => {
	it("gives every reason a screen with a way on, and never a way to skip past the first index: the Finder is already open", () => {
		for (const reason of INDEX_FAILURE_REASONS) {
			const spec = pauseSpec(failure(reason, reason === "folder-unreadable" ? ["/Volumes/Work/Projects"] : []));
			expect(spec.exits.length).toBeGreaterThan(0);
			expect(spec.exits).not.toContain("openAnyway");
			expect(spec.exits).toContain("retry");
			expect(new Set(spec.exits).size).toBe(spec.exits.length);
		}
	});

	it("sends a refused embedder to the embedding choice first, because retrying cannot change the answer", () => {
		expect(pauseSpec(failure("embedder-config")).exits).toEqual(["changeEmbedding", "retry"]);
	});

	it("retries an offline embedder by itself, every 8 seconds up to 6 times", () => {
		const spec = pauseSpec(failure("embedder-offline"));
		expect(spec.exits).toEqual(["retry", "changeEmbedding"]);
		expect(spec.auto).toEqual({ everySeconds: 8, max: 6 });
	});

	it("looks at an unreadable folder again every 3 seconds without giving up, and offers to leave it out", () => {
		const spec = pauseSpec(failure("folder-unreadable", ["/Volumes/Work/Projects"]));
		expect(spec.exits).toEqual(["retry", "excludeFolders"]);
		expect(spec.auto).toEqual({ everySeconds: 3, max: null });
	});

	it("names the folder by its last path segment, on either separator style", () => {
		expect(pauseSpec(failure("folder-unreadable", ["/Volumes/Work/Projects/"])).title).toEqual({ key: "onboarding.indexing.pause.folder.title", vars: { folder: "Projects" } });
		expect(pauseSpec(failure("folder-unreadable", ["D:\\Work\\Docs"])).title.vars).toEqual({ folder: "Docs" });
	});

	it("counts the folders when more than one cannot be read", () => {
		const spec = pauseSpec(failure("folder-unreadable", ["/a", "/b", "/c"]));
		expect(spec.title).toEqual({ key: "onboarding.indexing.pause.folder.titleMany", vars: { count: 3 } });
		expect(spec.excludeLabel).toEqual({ key: "onboarding.indexing.pause.exit.excludeMany" });
	});

	it("does not retry on its own for a full disk, an unknown cause, or a refused embedder", () => {
		for (const reason of ["disk-full", "unknown", "embedder-config"] as const) expect(pauseSpec(failure(reason)).auto).toBeNull();
	});

	it("never offers to leave a folder out unless a folder is the problem", () => {
		for (const reason of INDEX_FAILURE_REASONS) {
			if (reason !== "folder-unreadable") expect(pauseSpec(failure(reason)).exits).not.toContain("excludeFolders");
		}
	});
});

describe("pauseExits", () => {
	it("keeps the designed order until something repeats", () => {
		const spec = pauseSpec(failure("unknown"));
		expect(pauseExits(spec, fresh)).toEqual(["retry", "changeEmbedding"]);
	});

	it("moves the button off 'retry' when a retry from this screen failed again", () => {
		const spec = pauseSpec(failure("unknown"));
		expect(pauseExits(spec, { manualRepeats: 1, autoAttempts: 0 })).toEqual(["changeEmbedding", "retry"]);
	});

	it("keeps an automatically retried reason on 'retry' while attempts remain, and moves on once they are used up", () => {
		const spec = pauseSpec(failure("embedder-offline"));
		expect(pauseExits(spec, { manualRepeats: 0, autoAttempts: 5 })[0]).toBe("retry");
		expect(pauseExits(spec, { manualRepeats: 0, autoAttempts: 6 })).toEqual(["changeEmbedding", "retry"]);
	});

	it("never turns an unbounded automatic reason's attempts into a repeat", () => {
		const spec = pauseSpec(failure("folder-unreadable", ["/a"]));
		expect(pauseExits(spec, { manualRepeats: 0, autoAttempts: 500 })[0]).toBe("retry");
	});
});

describe("pauseLine", () => {
	const offline = pauseSpec(failure("embedder-offline"));
	const unknown = pauseSpec(failure("unknown"));

	it("says what is happening now before anything else", () => {
		expect(pauseLine(offline, fresh, { countdown: 5, retrying: true })).toEqual({ key: "onboarding.indexing.pause.line.retrying", tone: "plain" });
	});

	it("counts down to the next automatic try", () => {
		expect(pauseLine(offline, fresh, { countdown: 5, retrying: false })).toEqual({ key: "onboarding.indexing.pause.line.countdown", vars: { seconds: 5 }, tone: "plain" });
	});

	it("says the automatic tries are over once they are", () => {
		expect(pauseLine(offline, { manualRepeats: 0, autoAttempts: 6 }, { countdown: null, retrying: false })).toEqual({ key: "onboarding.indexing.pause.line.exhausted", tone: "again" });
	});

	it("says the same thing stopped it again after a retry that failed", () => {
		expect(pauseLine(unknown, { manualRepeats: 1, autoAttempts: 0 }, { countdown: null, retrying: false })).toEqual({ key: "onboarding.indexing.pause.line.again", tone: "again" });
	});

	it("otherwise gives the one line for the reason", () => {
		expect(pauseLine(unknown, fresh, { countdown: null, retrying: false })).toEqual({ key: "onboarding.indexing.pause.unknown.line", tone: "plain" });
	});

	it("keeps a watched-without-end reason's own line instead of a restarting countdown", () => {
		const folder = pauseSpec(failure("folder-unreadable", ["/Volumes/Work/Projects"]));
		expect(pauseLine(folder, fresh, { countdown: 2, retrying: false })).toEqual({ key: "onboarding.indexing.pause.folder.line", tone: "plain" });
	});
});
