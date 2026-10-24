import { describe, expect, it } from "vitest";
import type { IndexFailure } from "../src/shared/index-failure";
import { NO_INDEX_PROBLEM, type IndexProblem } from "../src/shared/index-problem-contract";
import { describeIndexProblem } from "../src/renderer/src/state/index-problem";
import { setAppLanguage, t } from "../src/shared/i18n";

function problem(overrides: Partial<IndexProblem>): IndexProblem {
	return { ...NO_INDEX_PROBLEM, at: "2026-10-24T05:00:00.000Z", ...overrides };
}

function failed(reason: IndexFailure["reason"], folders: readonly string[] = []): IndexProblem {
	return problem({ failure: { reason, folders, code: null } });
}

describe("describeIndexProblem", () => {
	it("shows nothing while the index works", async () => {
		await setAppLanguage("ko");
		expect(describeIndexProblem(NO_INDEX_PROBLEM, t)).toBeNull();
	});

	it("leads with the embedding choice only when the embedder refused", async () => {
		await setAppLanguage("ko");
		expect(describeIndexProblem(failed("embedder-config"), t)).toMatchObject({ tone: "error", primary: { kind: "fixEmbedding" }, secondary: { kind: "retry" } });
	});

	it("leads with the retry and offers no alternative when nothing else can be done", async () => {
		await setAppLanguage("ko");
		for (const reason of ["embedder-offline", "folder-unreadable"] as const) {
			expect(describeIndexProblem(failed(reason), t)).toMatchObject({ primary: { kind: "retry" }, secondary: null });
		}
	});

	it("leads with the retry and keeps the embedding choice behind it for the rest", async () => {
		await setAppLanguage("ko");
		for (const reason of ["model-download", "disk-full", "unknown"] as const) {
			expect(describeIndexProblem(failed(reason), t)).toMatchObject({ primary: { kind: "retry" }, secondary: { kind: "fixEmbedding" } });
		}
	});

	it("names the folder it cannot read, and counts them when there are several", async () => {
		await setAppLanguage("ko");
		const one = describeIndexProblem(failed("folder-unreadable", ["/Volumes/Work SSD/Projects"]), t);
		expect(one).toMatchObject({ primary: { kind: "retry" }, secondary: null, folderName: "Projects", itemTitle: "폴더", itemDetail: "Projects" });
		expect(one?.title).toContain("Projects");
		expect(one?.sideDetail).toBe("Projects");

		const windows = describeIndexProblem(failed("folder-unreadable", ["C:\\Users\\me\\Projects"]), t);
		expect(windows?.folderName).toBe("Projects");

		const many = describeIndexProblem(failed("folder-unreadable", ["/Volumes/One", "/Volumes/Two"]), t);
		expect(many).toMatchObject({ folderName: null, primary: { kind: "retry" } });
		expect(many?.title).toContain("2");
		expect(many?.itemDetail).toContain("2");

		// A record with no folder at all still says what it is about.
		expect(describeIndexProblem(failed("folder-unreadable"), t)).toMatchObject({ folderName: null, primary: { kind: "retry" } });
	});

	it("counts the files a finished run left out, and calls that run done", async () => {
		await setAppLanguage("ko");
		const view = describeIndexProblem(problem({ skipped: 22 }), t);
		expect(view).toMatchObject({ retrying: false, tone: "error", cardTone: "ok", cardTitle: "인덱싱 완료", primary: { kind: "retry" }, secondary: null, folderName: null });
		expect(view?.title).toContain("22");
		expect(view?.sideDetail).not.toContain("22");
	});

	it("reports the failure, not the skipped count, when a run left both", async () => {
		await setAppLanguage("ko");
		const both = problem({ failure: { reason: "disk-full", folders: [], code: null }, skipped: 22 });
		expect(describeIndexProblem(both, t)).toEqual(describeIndexProblem(failed("disk-full"), t));
	});

	it("replaces the problem with the running line, and every action, while a retry runs", async () => {
		await setAppLanguage("ko");
		const failure = { reason: "disk-full", folders: [], code: null } as const;
		const waiting = describeIndexProblem(problem({ failure, skipped: 3 }), t);
		const retrying = describeIndexProblem(problem({ failure, skipped: 3, retrying: true }), t);
		expect(retrying).toMatchObject({ retrying: true, tone: "run", cardTone: "run", sideDetail: null, primary: null, secondary: null });
		expect(retrying?.title).not.toBe(waiting?.title);
		// The row still says what the run is about, and the count stays out of it.
		expect(retrying?.itemTitle).toBe(waiting?.itemTitle);
		expect(retrying?.itemDetail).toBe(waiting?.itemDetail);
	});
});
