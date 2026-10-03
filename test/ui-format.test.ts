import { describe, expect, it } from "vitest";
import { RECENTS_PATH } from "../src/shared/fs-contract";
import {
	emptyStateText,
	formatModified,
	formatSize,
	indexToast,
	parseModifiedLabel,
	tileLabel,
	trashToast,
} from "../src/renderer/src/state/format";

describe("formatModified", () => {
	it("renders the reference date format", () => {
		expect(formatModified("2026-09-13T16:48:00")).toBe("Sep 13, 16:48");
		expect(formatModified("2026-01-02T09:05:00")).toBe("Jan 2, 09:05");
	});

	it("falls back to an em dash for an unreadable timestamp", () => {
		expect(formatModified("not-a-date")).toBe("—");
	});

	it("round-trips into a sortable value", () => {
		expect(parseModifiedLabel("Sep 13, 16:48")).toBeGreaterThan(parseModifiedLabel("Sep 13, 09:05"));
		expect(parseModifiedLabel("Oct 1, 00:00")).toBeGreaterThan(parseModifiedLabel("Sep 30, 23:59"));
		expect(parseModifiedLabel("—")).toBe(0);
	});
});

describe("formatSize", () => {
	it("uses the reference units", () => {
		expect(formatSize(86016)).toBe("84 KB");
		expect(formatSize(5033164)).toBe("4.8 MB");
		expect(formatSize(1048576)).toBe("1.0 MB");
		expect(formatSize(6144)).toBe("6 KB");
		expect(formatSize(512)).toBe("512 B");
	});

	it("renders folders as an em dash", () => {
		expect(formatSize(null)).toBe("—");
	});
});

describe("emptyStateText", () => {
	it("names the empty folder and the empty search", () => {
		expect(emptyStateText("")).toBe("빈 폴더");
		expect(emptyStateText("예산")).toBe('"예산"와 일치하는 파일이 없습니다');
	});

	it("names the empty Recents view instead of an empty folder", () => {
		expect(emptyStateText("", RECENTS_PATH)).toBe("최근에 연 파일이 없습니다");
		expect(emptyStateText("예산", RECENTS_PATH)).toBe('"예산"와 일치하는 파일이 없습니다');
	});
});

describe("toasts", () => {
	it("names a single trashed item and counts many", () => {
		expect(trashToast(["Documents/Finance/a.pdf"])).toBe("a.pdf — 휴지통으로 이동했습니다");
		expect(trashToast(["a.pdf", "b.pdf", "c.pdf"])).toBe("3개 항목을 휴지통으로 이동했습니다");
	});

	it("reports index include and exclude", () => {
		expect(indexToast("a.pdf", false)).toBe("a.pdf — 인덱싱에서 제외했습니다");
		expect(indexToast("a.pdf", true)).toBe("a.pdf — 인덱싱에 포함했습니다");
	});
});

describe("tileLabel", () => {
	const width = (text: string) => [...text].reduce((sum, char) => sum + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);

	it("keeps short names whole", () => {
		expect(tileLabel("report.pdf")).toBe("report.pdf");
		expect(tileLabel("(주)마커_보안서약서.pdf")).toBe("(주)마커_보안서약서.pdf");
	});

	it("cuts long names in the middle and keeps the extension", () => {
		const name = "(주)마커_2026년 오픈소스 AI 개발 지원사업 수행계획서 최종본 (1).hwp";
		const label = tileLabel(name);
		expect(label).toContain("…");
		expect(label.startsWith("(주)마커_2026")).toBe(true);
		expect(label.endsWith(".hwp")).toBe(true);
		expect(width(label)).toBeLessThanOrEqual(28);
	});

	it("handles long names without an extension", () => {
		const label = tileLabel("a-very-long-folder-name-without-any-extension-at-all");
		expect(label).toContain("…");
		expect(label.endsWith("all")).toBe(true);
		expect(width(label)).toBeLessThanOrEqual(28);
	});
});
