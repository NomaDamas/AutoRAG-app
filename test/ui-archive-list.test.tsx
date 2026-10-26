// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArchivePreview, PreviewDocument, QuickLookWindowBridge } from "../src/preview/shared/contract";
import { ArchiveListView } from "../src/preview/ui/archive";
import { ChromeProvider, type QuickLookChrome } from "../src/preview/ui/chrome";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const never = (): Promise<never> => new Promise(() => undefined);

function bridgeAnswering(answer: (path: string) => Promise<ArchivePreview>): QuickLookWindowBridge {
	return {
		platform: "darwin",
		language: "en",
		onLanguage: () => () => undefined,
		onLoad: () => () => undefined,
		onUnload: () => () => undefined,
		onZoom: () => () => undefined,
		onApp: () => () => undefined,
		onOffice: () => () => undefined,
		ready: () => undefined,
		zoomed: () => undefined,
		request: never,
		details: never,
		sha256: never,
		folderSize: never,
		audioMetadata: never,
		dataPreview: never,
		archivePreview: answer,
		share: never,
		copyText: never,
	};
}

function fileAt(path: string): PreviewDocument {
	return {
		name: path.split("/").pop() ?? path,
		path,
		ext: path.split(".").pop() ?? "",
		size: 2048,
		modifiedAt: "2026-01-02T03:04:05.000Z",
		mime: "application/octet-stream",
		truncated: false,
		bytes: null,
		pages: null,
		office: null,
		thumbnail: null,
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("en");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

async function show(file: PreviewDocument, answer: (path: string) => Promise<ArchivePreview>): Promise<void> {
	const chrome: QuickLookChrome = { bridge: bridgeAnswering(answer), toolbar: null, report: () => undefined, resize: () => undefined, hideTitle: () => undefined, app: null };
	await act(async () => {
		root.render(
			<ChromeProvider value={chrome}>
				<ArchiveListView file={file} />
			</ChromeProvider>,
		);
	});
}

describe("the archive list panel", () => {
	it("asks the main process for the shown file and draws the zip panel from the answer", async () => {
		const asked: string[] = [];
		await show(fileAt("/tmp/sample.7z"), async (path) => {
			asked.push(path);
			return {
				kind: "entries",
				entries: [
					{ name: "docs/", size: 12, modified: Date.UTC(2024, 0, 2) },
					{ name: "readme.md", size: 3, modified: Date.UTC(2022, 4, 6) },
				],
			};
		});
		expect(asked).toEqual(["/tmp/sample.7z"]);
		expect(host.textContent).toContain("sample.7z");
		expect(host.textContent).toContain("7-Zip archive");
		expect(host.textContent).toContain("2 items");
		expect(host.textContent).toContain("docs");
		expect(host.textContent).toContain("readme.md");
	});

	it("draws the full panel while the listing is still being read", async () => {
		await show(fileAt("/tmp/slow.rar"), never);
		expect(host.textContent).toContain("slow.rar");
		expect(host.textContent).toContain("RAR archive");
		expect(host.textContent).not.toContain("items");
	});

	it("shows the reason in place of the items when the archive cannot be listed", async () => {
		await show(fileAt("/tmp/locked.rar"), async () => ({ kind: "unreadable", reason: "encrypted" }));
		expect(host.textContent).toContain("This archive is password-protected, so its contents can’t be listed");
		expect(host.textContent).toContain("locked.rar");
	});

	it("shows the error's own message when the main process refuses", async () => {
		await show(fileAt("/tmp/odd.7z"), () => Promise.reject(new Error("Quick Look is not attached to this window")));
		expect(host.textContent).toContain("Quick Look is not attached to this window");
	});
});
