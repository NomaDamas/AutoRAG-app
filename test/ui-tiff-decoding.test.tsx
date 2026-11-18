// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PreviewDocument, QuickLookWindowBridge } from "../src/preview/shared/contract";
import { ChromeProvider, type QuickLookChrome } from "../src/preview/ui/chrome";
import { TiffView } from "../src/preview/ui/media";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function tiff(overrides: Partial<PreviewDocument>): PreviewDocument {
	return {
		name: "scan.tif",
		path: "/tmp/scan.tif",
		ext: "tif",
		size: 1234,
		modifiedAt: "2026-01-02T03:04:05.000Z",
		mime: "image/tiff",
		truncated: false,
		bytes: null,
		pages: null,
		office: null,
		thumbnail: null,
		slidesRendering: false,
		...overrides,
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("en");
	URL.createObjectURL = () => "blob:decoded";
	URL.revokeObjectURL = () => undefined;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

async function render(file: PreviewDocument): Promise<void> {
	const chrome: QuickLookChrome = { bridge: {} as QuickLookWindowBridge, toolbar: null, report: () => undefined, resize: () => undefined, hideTitle: () => undefined, app: null };
	await act(async () =>
		root.render(
			<ChromeProvider value={chrome}>
				<TiffView file={file} />
			</ChromeProvider>,
		),
	);
}

describe("the TIFF panel while the main process decodes", () => {
	it("shows a loading state, not a failure, until the picture arrives", async () => {
		await render(tiff({ decoding: true }));
		expect(host.textContent).toContain("Loading");
		expect(host.textContent).not.toContain("Couldn’t read the image");
		expect(host.querySelector("img")).toBeNull();
	});

	it("swaps the loading state for the decoded picture in place", async () => {
		await render(tiff({ decoding: true }));
		await render(tiff({ decoding: false, mime: "image/png", bytes: PNG }));
		expect(host.querySelector("img.ql__image")?.getAttribute("src")).toBe("blob:decoded");
	});

	it("says so when the decode produced nothing", async () => {
		await render(tiff({ decoding: true }));
		await render(tiff({ decoding: false }));
		expect(host.textContent).toContain("Couldn’t read the image");
		expect(host.querySelector("img")).toBeNull();
	});
});
