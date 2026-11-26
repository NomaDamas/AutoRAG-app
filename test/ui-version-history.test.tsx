// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsVersionHistoryResult } from "../src/shared/fs-contract";
import { setAppLanguage } from "../src/shared/i18n";
import {
	clearVersionHistoryCache,
	VersionHistorySection,
	type InspectorFamily,
} from "../src/renderer/src/components/VersionHistorySection";
import type { FinderEntry } from "../src/renderer/src/data/entries";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	clearVersionHistoryCache();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	clearVersionHistoryCache();
	await setAppLanguage("ko");
});

function makeEntry(path: string, name: string, mtimeMs: number): FinderEntry {
	return {
		kind: "file",
		path,
		name,
		ext: "md",
		size: 256,
		mtimeMs,
		birthtimeMs: mtimeMs,
	};
}

const SAMPLE_FAMILY: InspectorFamily = {
	headPath: "/docs/plan_final.md",
	headName: "plan_final.md",
	headMtimeMs: Date.parse("2026-10-10T10:00:00Z"),
	members: [
		{
			path: "/docs/plan_v2.md",
			name: "plan_v2.md",
			relation: "near",
			where: "/docs",
			mtimeMs: Date.parse("2026-10-05T10:00:00Z"),
		},
		{
			path: "/docs/plan_v1.md",
			name: "plan_v1.md",
			relation: "contains",
			where: "/docs",
			mtimeMs: Date.parse("2026-10-01T10:00:00Z"),
		},
	],
};

const SAMPLE_HISTORY: FsVersionHistoryResult = {
	versions: [
		{
			path: "/docs/plan_final.md",
			name: "plan_final.md",
			mtimeMs: Date.parse("2026-10-10T10:00:00Z"),
			relation: "latest",
			isLatest: true,
			previousPath: "/docs/plan_v2.md",
			diff: {
				previousPath: "/docs/plan_v2.md",
				currentPath: "/docs/plan_final.md",
				status: "changed",
				summary: {
					addedCount: 2,
					removedCount: 1,
					addedHighlights: ["예산 1.2억 확정", "최종 승인 완료"],
					removedHighlights: ["예산 1억 검토 중"],
				},
				hunks: [
					{
						previousStart: 2,
						previousCount: 2,
						currentStart: 2,
						currentCount: 3,
						lines: [
							{ kind: "context", text: "프로젝트 개요", previousLine: 2, currentLine: 2 },
							{ kind: "removed", text: "예산 1억 검토 중", previousLine: 3, currentLine: null },
							{ kind: "added", text: "예산 1.2억 확정", previousLine: null, currentLine: 3 },
							{ kind: "added", text: "최종 승인 완료", previousLine: null, currentLine: 4 },
						],
					},
				],
				truncated: false,
			},
		},
		{
			path: "/docs/plan_v2.md",
			name: "plan_v2.md",
			mtimeMs: Date.parse("2026-10-05T10:00:00Z"),
			relation: "near",
			isLatest: false,
			previousPath: "/docs/plan_v1.md",
			diff: {
				previousPath: "/docs/plan_v1.md",
				currentPath: "/docs/plan_v2.md",
				status: "identical",
				summary: {
					addedCount: 0,
					removedCount: 0,
					addedHighlights: [],
					removedHighlights: [],
				},
				hunks: [],
				truncated: false,
			},
		},
		{
			path: "/docs/plan_v1.md",
			name: "plan_v1.md",
			mtimeMs: Date.parse("2026-10-01T10:00:00Z"),
			relation: "contains",
			isLatest: false,
			previousPath: null,
			diff: null,
		},
	],
};

describe("VersionHistorySection", () => {
	it("renders timeline entries with concise added/removed summaries, identical notice, and base version label", async () => {
		const loadVersionHistory = vi.fn(async () => SAMPLE_HISTORY);
		const onOpenMember = vi.fn();

		await act(async () => {
			root.render(
				<VersionHistorySection
					family={SAMPLE_FAMILY}
					entry={makeEntry("/docs/plan_final.md", "plan_final.md", Date.parse("2026-10-10T10:00:00Z"))}
					onOpenMember={onOpenMember}
					loadVersionHistory={loadVersionHistory}
				/>,
			);
		});

		expect(loadVersionHistory).toHaveBeenCalledTimes(1);

		const items = [...host.querySelectorAll('[role="listitem"]')];
		expect(items).toHaveLength(3);
		expect(items[0]?.getAttribute("data-version-current")).toBe("true");

		// Latest version shows concise added/removed lines and counts
		const latestText = items[0]?.textContent ?? "";
		expect(latestText).toContain("최신본");
		expect(latestText).toContain("+2줄");
		expect(latestText).toContain("-1줄");
		expect(latestText).toContain("예산 1.2억 확정");
		expect(latestText).toContain("예산 1억 검토 중");

		// Identical predecessor notice
		expect(items[1]?.querySelector('[data-diff-status="identical"]')?.textContent).toContain("이전 버전과 내용 동일");

		// Base version marker
		expect(items[2]?.querySelector('[data-diff-status="base"]')?.textContent).toContain("기준 버전");
	});

	it("opens and closes the detailed diff modal with Escape and reveals member on click", async () => {
		const loadVersionHistory = vi.fn(async () => SAMPLE_HISTORY);
		const onOpenMember = vi.fn();

		await act(async () => {
			root.render(
				<VersionHistorySection
					family={SAMPLE_FAMILY}
					entry={makeEntry("/docs/plan_final.md", "plan_final.md", Date.parse("2026-10-10T10:00:00Z"))}
					onOpenMember={onOpenMember}
					loadVersionHistory={loadVersionHistory}
				/>,
			);
		});

		const detailBtn = host.querySelector<HTMLButtonElement>('[data-action="version-diff-detail"]');
		expect(detailBtn).not.toBeNull();

		await act(async () => {
			detailBtn!.click();
		});

		const dialog = host.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain("직전 버전(plan_v2.md) 대비");
		expect(dialog?.querySelectorAll('[data-diff-line="added"]')).toHaveLength(2);
		expect(dialog?.querySelectorAll('[data-diff-line="removed"]')).toHaveLength(1);

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(host.querySelector('[role="dialog"]')).toBeNull();

		// Clicking a timeline entry reveals that file
		const v2Button = host.querySelector<HTMLButtonElement>('[data-version-path="/docs/plan_v2.md"] button');
		expect(v2Button).not.toBeNull();
		await act(async () => {
			v2Button!.click();
		});
		expect(onOpenMember).toHaveBeenCalledWith("/docs/plan_v2.md");
	});

	it("translates labels cleanly when switching to English", async () => {
		await act(() => setAppLanguage("en"));
		const loadVersionHistory = vi.fn(async () => SAMPLE_HISTORY);

		await act(async () => {
			root.render(
				<VersionHistorySection
					family={SAMPLE_FAMILY}
					entry={makeEntry("/docs/plan_final.md", "plan_final.md", Date.parse("2026-10-10T10:00:00Z"))}
					onOpenMember={() => {}}
					loadVersionHistory={loadVersionHistory}
				/>,
			);
		});

		expect(host.textContent).toContain("Version History");
		expect(host.textContent).toContain("View diff");
		expect(host.textContent).toContain("Base version");
	});
});
