// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathFromPreviewUrl, type PreviewDocument } from "../src/preview/shared/contract";
import { ImageView } from "../src/preview/ui/media";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function picture(modifiedAt: string, size: number): PreviewDocument {
	return {
		name: "swap.png",
		path: "/Users/me/Pictures/swap.png",
		ext: "png",
		size,
		modifiedAt,
		mime: "image/png",
		truncated: false,
		bytes: null,
		pages: null,
		office: null,
		thumbnail: null,
		slidesRendering: false,
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function imageSrc(file: PreviewDocument): string {
	act(() => root.render(<ImageView file={file} />));
	const src = host.querySelector("img")?.getAttribute("src");
	if (src === null || src === undefined) throw new Error("no picture rendered");
	return src;
}

describe("Quick Look picture of a file replaced in place", () => {
	// The panel is one long-lived page: a picture URL that names only the path
	// is answered from the page's decoded-image cache, so Space showed the old
	// picture after the file was rewritten under the same name.
	it("loads a new URL once the file's content changes, for the same path", () => {
		const before = imageSrc(picture("2026-11-02T05:00:00.000Z", 1200));
		const rewritten = imageSrc(picture("2026-11-02T05:00:07.250Z", 1200));
		const resized = imageSrc(picture("2026-11-02T05:00:07.250Z", 980));

		expect(rewritten).not.toBe(before);
		expect(resized).not.toBe(rewritten);
		for (const src of [before, rewritten, resized]) expect(pathFromPreviewUrl(src)).toBe("/Users/me/Pictures/swap.png");
	});

	it("keeps the same URL while the file is unchanged", () => {
		expect(imageSrc(picture("2026-11-02T05:00:00.000Z", 1200))).toBe(imageSrc(picture("2026-11-02T05:00:00.000Z", 1200)));
	});
});
