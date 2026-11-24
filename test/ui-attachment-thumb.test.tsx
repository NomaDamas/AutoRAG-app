// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentThumb } from "../src/renderer/src/components/AttachmentThumb";
import { InspectorChatDock } from "../src/renderer/src/components/InspectorChat";
import { isThumbnailAttachment } from "../src/renderer/src/state/attachments";
import { setAppLanguage } from "../src/shared/i18n";
import type { ChatAttachment } from "../src/shared/search-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const shot: ChatAttachment = { kind: "file", id: "/data/pasted-images/pasted-image-ab12cd34.png", name: "pasted-image-ab12cd34.png" };
const doc: ChatAttachment = { kind: "file", id: "/work/deck.pdf", name: "deck.pdf" };

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
	await setAppLanguage("en");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("isThumbnailAttachment", () => {
	it("is true for image files only", () => {
		expect(isThumbnailAttachment(shot)).toBe(true);
		expect(isThumbnailAttachment({ ...shot, name: "PHOTO.JPG" })).toBe(true);
		expect(isThumbnailAttachment(doc)).toBe(false);
		expect(isThumbnailAttachment({ kind: "folder", id: "/x/pics.png", name: "pics.png" })).toBe(false);
		expect(isThumbnailAttachment({ kind: "url", id: "https://a.b/x.png", name: "x.png" })).toBe(false);
	});
});

describe("AttachmentThumb", () => {
	it("shows the picture itself, streamed from the file", () => {
		act(() => root.render(<AttachmentThumb att={shot} size="composer" fallback={<span id="fallback" />} />));
		const img = host.querySelector("img");
		expect(img).not.toBeNull();
		expect(new URL(img!.src).searchParams.get("path")).toBe(shot.id);
		expect(host.querySelector("#fallback")).toBeNull();
		expect(host.querySelector("button")).toBeNull();
	});

	it("takes the attachment off with its ✕", () => {
		const removed = vi.fn();
		act(() => root.render(<AttachmentThumb att={shot} size="composer" removeLabel="Remove attachment" onRemove={removed} fallback={null} />));
		const button = host.querySelector<HTMLButtonElement>('button[aria-label="Remove attachment"]');
		expect(button).not.toBeNull();
		act(() => button!.click());
		expect(removed).toHaveBeenCalledTimes(1);
	});

	it("falls back to the ordinary chip when the picture cannot be drawn", () => {
		act(() => root.render(<AttachmentThumb att={shot} size="message" fallback={<span id="fallback">chip</span>} />));
		act(() => void host.querySelector("img")!.dispatchEvent(new Event("error")));
		expect(host.querySelector("img")).toBeNull();
		expect(host.querySelector("#fallback")?.textContent).toBe("chip");
	});

	it("is not a picture for a document: it renders the fallback straight away", () => {
		act(() => root.render(<AttachmentThumb att={doc} size="composer" fallback={<span id="fallback" />} />));
		expect(host.querySelector("img")).toBeNull();
		expect(host.querySelector("#fallback")).not.toBeNull();
	});
});

describe("the sidebar composer with a pasted image", () => {
	it("shows the picture with its ✕, and the ✕ removes it before anything is sent", async () => {
		const pasteImage = vi.fn(async () => shot);
		Reflect.set(window, "autorag", { search: { pasteImage } });
		const asked: (readonly ChatAttachment[])[] = [];
		act(() =>
			root.render(
				<InspectorChatDock
					tab={{ mode: "info", seenAt: 0, dismissed: [], queued: [], chat: null }}
					now={0}
					targets={[]}
					running={false}
					request={null}
					onAsk={(_text, pasted) => (asked.push(pasted), true)}
					onSummarize={() => undefined}
					onStop={() => undefined}
					onResume={() => undefined}
				/>,
			),
		);
		const field = host.querySelector("textarea")!;
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", {
			value: { getData: () => "", items: [{ kind: "file", type: "image/png", getAsFile: () => new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }) }] },
		});
		await act(async () => {
			field.dispatchEvent(paste);
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(pasteImage).toHaveBeenCalledTimes(1);
		expect(host.querySelector("img")?.getAttribute("alt")).toBe(shot.name);
		act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Remove attachment"]')!.click());
		expect(host.querySelector("img")).toBeNull();

		// With the picture removed, the question goes without it.
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
			setter.call(field, "hello");
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => void field.form!.requestSubmit());
		expect(asked).toEqual([[]]);
	});
});
