// @vitest-environment happy-dom
import { act, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewDocument, QuickLookWindowBridge } from "../src/preview/shared/contract";
import { ChromeProvider, useChrome, type QuickLookChrome } from "../src/preview/ui/chrome";
import { PdfView } from "../src/preview/ui/pdf";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// pdf.js answers `onPassword(update, reason)` with 1 (password needed) or 2 (the last one was wrong).
type Unlock = (password: string) => void;
interface FakeTask {
	onPassword: ((update: Unlock, reason: number) => void) | null;
	promise: Promise<unknown>;
	destroy: () => Promise<void>;
	resolve: (pdf: unknown) => void;
	reject: (error: Error) => void;
}
const tasks: FakeTask[] = [];

vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: {},
	PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
	getDocument: () => {
		let resolve: (pdf: unknown) => void = () => undefined;
		let reject: (error: Error) => void = () => undefined;
		const promise = new Promise<unknown>((ok, fail) => {
			resolve = ok;
			reject = fail;
		});
		const task: FakeTask = { onPassword: null, promise, destroy: async () => undefined, resolve, reject };
		tasks.push(task);
		return task;
	},
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "worker.js" }));
vi.mock("../src/preview/ui/paged", () => ({
	PagedView: function PagedStub({ boxes }: { readonly boxes: readonly unknown[] }): ReactElement {
		const { report } = useChrome();
		useEffect(() => report({ width: 700, height: 900 }, "clamp"), [report]);
		return <div data-testid="pages">{boxes.length} pages</div>;
	},
}));

const file: PreviewDocument = { path: "/tmp/locked.pdf", name: "locked.pdf", ext: "pdf", size: 1234, modifiedAt: 0, bytes: null } as unknown as PreviewDocument;

function openedPdf(): unknown {
	return { numPages: 2, getPage: async () => ({ getViewport: () => ({ width: 100, height: 200 }) }) };
}

let host: HTMLDivElement;
let root: Root;
let textEntry: ReturnType<typeof vi.fn<(active: boolean) => void>>;
let report: ReturnType<typeof vi.fn<QuickLookChrome["report"]>>;
let resize: ReturnType<typeof vi.fn<QuickLookChrome["resize"]>>;

beforeEach(async () => {
	await setAppLanguage("en");
	tasks.length = 0;
	textEntry = vi.fn();
	report = vi.fn();
	resize = vi.fn();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const chrome: QuickLookChrome = {
		bridge: { textEntry } as unknown as QuickLookWindowBridge,
		toolbar: null,
		report,
		resize,
		hideTitle: () => undefined,
		app: null,
	};
	act(() => root.render(<ChromeProvider value={chrome}><PdfView file={file} /></ChromeProvider>));
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

const field = (): HTMLInputElement | null => host.querySelector("input[type=password]");
const submitButton = (): HTMLButtonElement | undefined => [...host.querySelectorAll("button")].find((button) => button.type === "submit");

function type(value: string): void {
	const input = field();
	if (input === null) throw new Error("no password field");
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	act(() => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function submit(): void {
	act(() => submitButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

async function ask(reason: number, update: Unlock): Promise<void> {
	await act(async () => tasks[0]?.onPassword?.(update, reason));
}

describe("PdfView on an encrypted PDF", () => {
	it("asks for the password instead of failing, and hands the typed one to pdf.js", async () => {
		const update = vi.fn<Unlock>();
		await ask(1, update);
		expect(field()).not.toBeNull();
		expect(host.textContent).toContain("locked.pdf");
		expect(host.textContent).not.toContain("Couldn’t open the PDF");
		type("open-sesame");
		submit();
		expect(update).toHaveBeenCalledExactlyOnceWith("open-sesame");
	});

	it("tells the window a text field is focused, so Space and the arrows reach it, and lets go afterwards", async () => {
		await ask(1, vi.fn());
		expect(textEntry).toHaveBeenLastCalledWith(true);
		await act(async () => {
			tasks[0]?.resolve(openedPdf());
		});
		expect(textEntry).toHaveBeenLastCalledWith(false);
	});

	it("keeps the password field and says so when the password was wrong", async () => {
		const update = vi.fn<Unlock>();
		await ask(1, update);
		expect(host.querySelector("[role=alert]")).toBeNull();
		type("nope");
		submit();
		await ask(2, update);
		expect(host.querySelector("[role=alert]")?.textContent).toContain("incorrect");
		expect(field()?.value).toBe("");
		type("open-sesame");
		submit();
		expect(update).toHaveBeenLastCalledWith("open-sesame");
	});

	it("does not submit an empty password", async () => {
		const update = vi.fn<Unlock>();
		await ask(1, update);
		expect(submitButton()?.disabled).toBe(true);
		act(() => field()?.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
		expect(update).not.toHaveBeenCalled();
	});

	it("shows the pages once pdf.js accepts the password", async () => {
		await ask(1, vi.fn());
		await act(async () => {
			tasks[0]?.resolve(openedPdf());
		});
		expect(field()).toBeNull();
		expect(host.querySelector("[data-testid=pages]")?.textContent).toBe("2 pages");
	});

	it("grows the window to the unlocked pages, though the prompt already sized it", async () => {
		await ask(1, vi.fn());
		await act(async () => {
			tasks[0]?.resolve(openedPdf());
		});
		expect(resize).toHaveBeenCalledWith({ width: 700, height: 900 });
	});

	it("sizes a PDF that was never locked through the first report, as before", async () => {
		await act(async () => {
			tasks[0]?.resolve(openedPdf());
		});
		expect(report).toHaveBeenCalledWith({ width: 700, height: 900 }, "clamp");
		expect(resize).not.toHaveBeenCalled();
	});

	it("still falls back for a PDF that fails for another reason", async () => {
		await act(async () => tasks[0]?.reject(new Error("Invalid PDF structure.")));
		expect(field()).toBeNull();
		expect(host.textContent).toContain("Invalid PDF structure.");
	});
});
