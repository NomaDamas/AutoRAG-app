import { describe, expect, it } from "vitest";
import { appDataNameOn, evaluateCriteria, SMART_INDEXING_CRITERIA, type FolderMeasure } from "../src/shared/smart-indexing-criteria";

const PLAIN: FolderMeasure = { indexedFiles: 100, totalFiles: 100, topExtension: ".md", topExtensionShare: 0.5, stemRatio: 0.9, appDataName: null };

describe("smart indexing criteria", () => {
	it("proposes nothing for a folder with too few indexed files, whatever else it looks like", () => {
		const tiny: FolderMeasure = { indexedFiles: SMART_INDEXING_CRITERIA.minIndexedFiles - 1, totalFiles: 5000, topExtension: ".txt", topExtensionShare: 1, stemRatio: 0, appDataName: "zoom" };

		expect(evaluateCriteria(tiny)).toEqual([]);
	});

	it("calls a folder a series when mostly plain text whose names differ only in digits", () => {
		const series: FolderMeasure = { ...PLAIN, indexedFiles: 60, totalFiles: 60, topExtension: ".txt", topExtensionShare: 0.95, stemRatio: 0.05 };

		expect(evaluateCriteria(series)).toEqual(["series"]);
		expect(evaluateCriteria({ ...series, indexedFiles: 49 })).toEqual([]);
		expect(evaluateCriteria({ ...series, topExtensionShare: 0.89 })).toEqual([]);
		expect(evaluateCriteria({ ...series, stemRatio: 0.11 })).toEqual([]);
		// Daily notes are numbered too, but they are the person's own writing.
		expect(evaluateCriteria({ ...series, topExtension: ".md" })).toEqual([]);
		expect(evaluateCriteria({ ...series, topExtension: ".pdf" })).toEqual([]);
	});

	it("calls a folder sparse when documents are a small share of a large folder", () => {
		const media: FolderMeasure = { ...PLAIN, indexedFiles: 30, totalFiles: 400 };

		expect(evaluateCriteria(media)).toEqual(["sparse"]);
		expect(evaluateCriteria({ ...media, totalFiles: 299 })).toEqual([]);
		// Exactly the limit is not below it.
		expect(evaluateCriteria({ ...media, indexedFiles: 30, totalFiles: 300 })).toEqual([]);
	});

	it("calls a folder app data when a name on its path is a known app or system folder", () => {
		expect(evaluateCriteria({ ...PLAIN, indexedFiles: 20, totalFiles: 20, appDataName: "Zoom" })).toEqual(["appData"]);
		expect(evaluateCriteria({ ...PLAIN, appDataName: null })).toEqual([]);
	});

	it("lists every criterion that holds, in a fixed order", () => {
		const all: FolderMeasure = { indexedFiles: 60, totalFiles: 900, topExtension: ".txt", topExtensionShare: 1, stemRatio: 0.01, appDataName: "logs" };

		expect(evaluateCriteria(all)).toEqual(["series", "sparse", "appData"]);
	});

	it("finds the first known app or system folder name among the names on a path, ignoring case", () => {
		expect(appDataNameOn(["Work", "Telegram Desktop", "photos"])).toBe("Telegram Desktop");
		expect(appDataNameOn(["Work", "LOGS"])).toBe("LOGS");
		expect(appDataNameOn(["Work", "Reports"])).toBeNull();
		expect(appDataNameOn([])).toBeNull();
	});
});
