import { describe, expect, it } from "vitest";
import { journalItemName, tallyMinsyncJournal } from "../src/main/index-progress-journal";

// The header and records below are lines MinSync 0.6.1 wrote for a real `minsync sync` of 400 files that was
// interrupted after two batches (`.minsync/progress.jsonl`). The `failed` and `deleted` lines follow journal.rs.
const HEADER =
	'{"format":3,"source_id":"bc74493a-2916-4e2a-bdf6-dd6452b6c931","stage":"vector","run_token":"282ed9f0377f4779a5f322367125d771","full":true,"baseline":"sha256:e3b0c4","fingerprint":"sha256:68d8fd","created_at":"2026-11-03T12:39:50.004242+00:00"}';
const committed = (item: string): string => `{"item":"${item}","version":"sha256:cd2c39cd5336","outcome":"committed"}`;

describe("tallyMinsyncJournal", () => {
	it("skips the run header and counts one file per record", () => {
		const text = [HEADER, committed("files/sub/d1.md"), committed("files/sub/d10.md"), committed("files/sub/d100.md")].join("\n") + "\n";
		expect(tallyMinsyncJournal(text)).toEqual({ committed: 3, deleted: 0, failed: 0, bytesDone: null, lastFile: "d100", modifiedAt: null });
	});

	it("keeps failed and deleted files out of the committed count", () => {
		const text = [
			HEADER,
			committed("files/a.pdf.md"),
			'{"item":"files/b.pdf.md","version":"sha256:aa","outcome":"failed","error":"embed: timed out"}',
			'{"item":"files/c.pdf.md","outcome":"deleted"}',
		].join("\n");
		expect(tallyMinsyncJournal(text)).toMatchObject({ committed: 1, failed: 1, deleted: 1, lastFile: "a.pdf" });
	});

	it("lets a file's last record decide, as a retried failure does", () => {
		const text = [HEADER, '{"item":"files/a.md","version":"v","outcome":"failed","error":"x"}', committed("files/a.md")].join("\n");
		expect(tallyMinsyncJournal(text)).toMatchObject({ committed: 1, failed: 0 });
	});

	it("ignores a torn last line and any line that is not a record", () => {
		const text = [HEADER, committed("files/a.md"), "garbage", '{"unrelated":true}', '{"item":"files/b.md","version":"sha256:cd2c', ].join("\n");
		expect(tallyMinsyncJournal(text)).toMatchObject({ committed: 1, failed: 0, deleted: 0 });
	});

	it("reads logs written before outcomes existed: a version is a completion, none is a deletion", () => {
		const text = [HEADER, '{"item":"files/a.md","version":"v1"}', '{"item":"files/b.md"}'].join("\n");
		expect(tallyMinsyncJournal(text)).toMatchObject({ committed: 1, deleted: 1 });
	});

	it("adds up the sizes of the committed files only, when it is told how to look them up", () => {
		const sizes = new Map([
			["files/a.md", 1_000],
			["files/b.md", 5_000],
			["files/c.md", 70],
		]);
		const text = [HEADER, committed("files/a.md"), '{"item":"files/b.md","version":"v","outcome":"failed","error":"x"}', committed("files/c.md")].join("\n");
		const tally = tallyMinsyncJournal(text, { sizeOf: (item) => sizes.get(item), modifiedAt: 42 });
		expect(tally).toMatchObject({ committed: 2, failed: 1, bytesDone: 1_070, modifiedAt: 42 });
	});

	it("leaves the bytes unknown when a committed file has no size, rather than counting it as 0", () => {
		const sizes = new Map([["files/a.md", 1_000]]);
		const text = [HEADER, committed("files/a.md"), committed("files/not-staged.md")].join("\n");
		const tally = tallyMinsyncJournal(text, { sizeOf: (item) => sizes.get(item) });
		expect(tally).toMatchObject({ committed: 2, bytesDone: null });
		// A file that was not committed does not need a size: only the work counted as done is measured.
		const failedOnly = [HEADER, committed("files/a.md"), '{"item":"files/not-staged.md","version":"v","outcome":"failed","error":"x"}'].join("\n");
		expect(tallyMinsyncJournal(failedOnly, { sizeOf: (item) => sizes.get(item) })).toMatchObject({ committed: 1, failed: 1, bytesDone: 1_000 });
		// No file committed yet: nothing to add up, and the sizes are known, so zero is true.
		expect(tallyMinsyncJournal(`${HEADER}\n`, { sizeOf: (item) => sizes.get(item) }).bytesDone).toBe(0);
	});

	it("is empty for an empty or header-only log", () => {
		expect(tallyMinsyncJournal("")).toMatchObject({ committed: 0, failed: 0, deleted: 0, lastFile: null });
		expect(tallyMinsyncJournal(`${HEADER}\n`)).toMatchObject({ committed: 0, lastFile: null });
	});
});

describe("journalItemName", () => {
	it("names the user's file, not its parsed copy", () => {
		expect(journalItemName("files/Users/me/docs/report.pdf.md")).toBe("report.pdf");
		expect(journalItemName("files\\Users\\me\\notes.md")).toBe("notes");
		expect(journalItemName("files/x/readme")).toBe("readme");
	});
});
