// @vitest-environment happy-dom
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerField } from "../src/renderer/src/components/ComposerField";
import { attachPastedImages, base64Of, imageFilesFromPaste, type PasteData } from "../src/renderer/src/state/pasted-images";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface FakeFile {
	readonly type: string;
	readonly bytes: number[];
	arrayBuffer(): Promise<ArrayBuffer>;
}

function file(type: string, bytes: number[] = [1, 2, 3]): FakeFile {
	return { type, bytes, arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

function paste(files: readonly FakeFile[], text = ""): PasteData<FakeFile> {
	return {
		getData: (format) => (format === "text/plain" ? text : ""),
		items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
	};
}

describe("imageFilesFromPaste", () => {
	it("returns the image files of a screenshot paste", () => {
		const shot = file("image/png");
		expect(imageFilesFromPaste(paste([shot]))).toEqual([shot]);
	});

	it("leaves a paste with text to the field, even if it carries a picture too", () => {
		expect(imageFilesFromPaste(paste([file("image/png")], "A1\tB1"))).toEqual([]);
	});

	it("ignores types the model cannot take and non-file items", () => {
		expect(imageFilesFromPaste(paste([file("image/svg+xml"), file("application/pdf")]))).toEqual([]);
		expect(imageFilesFromPaste({ getData: () => "", items: [{ kind: "string", type: "image/png", getAsFile: () => null }] })).toEqual([]);
		expect(imageFilesFromPaste(null)).toEqual([]);
	});
});

describe("attachPastedImages", () => {
	it("keeps each image through the bridge and drops the ones it refuses", async () => {
		const keep = vi.fn(async (mime: string, data: string) => (mime === "image/png" ? { kind: "file" as const, id: `/p/${data}.png`, name: `${data}.png` } : null));
		const out = await attachPastedImages([file("image/png", [104, 105]), file("image/gif")], keep);
		expect(out).toEqual([{ kind: "file", id: "/p/aGk=.png", name: "aGk=.png" }]);
	});

	it("never rejects when the bridge fails", async () => {
		expect(await attachPastedImages([file("image/png")], async () => Promise.reject(new Error("boom")))).toEqual([]);
	});

	it("encodes large images without overflowing the call stack", () => {
		const bytes = new Uint8Array(3_000_000).fill(7);
		expect(atob(base64Of(bytes.buffer)).length).toBe(3_000_000);
	});
});

describe("ComposerField paste", () => {
	let host: HTMLDivElement;
	let root: Root;
	let received: unknown[][];

	function Harness({ withHandler }: { readonly withHandler: boolean }): ReactElement {
		const [value, setValue] = useState("");
		return (
			<ComposerField
				value={value}
				onChange={setValue}
				onAltEnter={() => undefined}
				ariaLabel="Ask"
				{...(withHandler ? { onPasteImages: (files: readonly File[]) => void received.push([...files]) } : {})}
			/>
		);
	}

	beforeEach(() => {
		received = [];
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	function firePaste(files: readonly FakeFile[], text = ""): Event {
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: paste(files, text) });
		act(() => void host.querySelector("textarea")!.dispatchEvent(event));
		return event;
	}

	it("takes a pasted image off the field and hands it to the composer", async () => {
		await act(async () => root.render(<Harness withHandler />));
		const shot = file("image/png");
		const event = firePaste([shot]);
		expect(event.defaultPrevented).toBe(true);
		expect(received).toEqual([[shot]]);
	});

	it("leaves a text paste alone", async () => {
		await act(async () => root.render(<Harness withHandler />));
		const event = firePaste([], "plain text");
		expect(event.defaultPrevented).toBe(false);
		expect(received).toEqual([]);
	});

	it("leaves every paste alone when the composer takes no images", async () => {
		await act(async () => root.render(<Harness withHandler={false} />));
		expect(firePaste([file("image/png")]).defaultPrevented).toBe(false);
	});
});
