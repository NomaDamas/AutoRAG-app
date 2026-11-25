// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PathBar } from "../src/renderer/src/components/PathBar";
import { breadcrumbTrail } from "../src/renderer/src/state/paths";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Macintosh HD › Users › jeffrey › Desktop › Work › 2025-2 › bx (› report.pdf when a file is selected)
const PATH = "/Users/jeffrey/Desktop/Work/2025-2/bx";
const FILE = `${PATH}/report.pdf`;

let host: HTMLDivElement;
let root: Root;
let viewportWidth = 10_000;

/** happy-dom lays nothing out: every measured segment is 60px, "…" and a separator 10px, the viewport `viewportWidth`. */
function fakeBox(this: Element): DOMRect {
	const element = this as HTMLElement;
	let width = 0;
	if (element.matches("[data-measure-segment]")) width = 60;
	else if (element.matches("[data-measure-more], [data-measure-separator]")) width = 10;
	else if (element.matches(".path-label")) width = 30;
	else if (element.parentElement?.matches("nav.pathbar") === true && element.className.includes("flex-1")) width = viewportWidth;
	return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 20, width, height: 20, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(fakeBox);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	viewportWidth = 10_000;
});

function render(
	onCopyPath: (path: string) => void,
	options: { readonly path?: string; readonly withFile?: boolean; readonly selectedName?: string | null; readonly selectedPath?: string | null } = {},
): void {
	const path = options.path ?? PATH;
	const withFile = options.withFile ?? false;
	const selectedName = options.selectedName !== undefined ? options.selectedName : withFile ? "report.pdf" : null;
	const selectedPath = options.selectedPath !== undefined ? options.selectedPath : withFile ? FILE : null;
	act(() =>
		root.render(
			<PathBar
				path={path}
				crumbs={breadcrumbTrail(path, Number.MAX_SAFE_INTEGER)}
				selectedName={selectedName}
				selectedPath={selectedPath}
				onNavigate={() => {}}
				onCopyPath={onCopyPath}
				onGoToPath={() => Promise.resolve(true)}
				completePath={() => Promise.resolve([])}
				openEditor={0}
				onEditorClosed={() => {}}
			/>,
		),
	);
}

function rightClick(target: Element): MouseEvent {
	const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 10 });
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

const segment = (name: string): HTMLElement => {
	const found = [...host.querySelectorAll<HTMLElement>("nav.pathbar .path-trail .path-seg")].find((seg) => seg.querySelector(".path-name")?.textContent === name);
	if (found === undefined) throw new Error(`no segment ${name}`);
	return found;
};
const copyItem = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]');
const choose = (): void => {
	act(() => copyItem()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};

describe("PathBar right-click Copy Path", () => {
	it("copies a folder segment's own path and never opens the editor", () => {
		const onCopyPath = vi.fn();
		render(onCopyPath);
		const event = rightClick(segment("Work"));
		expect(event.defaultPrevented).toBe(true);
		expect(copyItem()?.textContent).toBe("contextMenu.copyPath");
		choose();
		expect(onCopyPath).toHaveBeenCalledExactlyOnceWith("/Users/jeffrey/Desktop/Work");
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(host.querySelector("nav.pathbar input")).toBeNull();
	});

	it("copies the selected file's full path from the file segment", () => {
		const onCopyPath = vi.fn();
		render(onCopyPath, { withFile: true });
		rightClick(segment("report.pdf"));
		choose();
		expect(onCopyPath).toHaveBeenCalledExactlyOnceWith(FILE);
	});

	it("copies the folder in view from the volume label and from the empty bar", () => {
		const onCopyPath = vi.fn();
		render(onCopyPath);
		rightClick(segment("Macintosh HD"));
		choose();
		rightClick(host.querySelector("nav.pathbar")!);
		choose();
		expect(onCopyPath.mock.calls).toEqual([[PATH], [PATH]]);
		expect(host.querySelector("nav.pathbar input")).toBeNull();
	});

	it("offers the same menu on folders folded into the dropdown", () => {
		viewportWidth = 230;
		const onCopyPath = vi.fn();
		render(onCopyPath);
		act(() => host.querySelector<HTMLElement>("nav.pathbar .path-trail [data-path-more]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const desktop = [...document.querySelectorAll<HTMLElement>('[role="menuitem"][data-copy-path]')].find((item) => item.textContent === "Desktop")!;
		rightClick(desktop);
		choose();
		expect(onCopyPath).toHaveBeenCalledExactlyOnceWith("/Users/jeffrey/Desktop");
		expect(host.querySelector("nav.pathbar input")).toBeNull();
	});

	it("closes on Escape without copying", () => {
		const onCopyPath = vi.fn();
		render(onCopyPath);
		rightClick(segment("bx"));
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		expect(copyItem()).toBeNull();
		expect(onCopyPath).not.toHaveBeenCalled();
	});

	it("dismisses the copy menu on an outside bar click (mousedown→mouseup→click) without opening the path editor", async () => {
		const onCopyPath = vi.fn();
		render(onCopyPath);
		rightClick(segment("Work"));
		expect(copyItem()).not.toBeNull();
		const nav = host.querySelector<HTMLElement>("nav.pathbar")!;
		act(() => {
			nav.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			nav.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		});
		// Flush microtasks between mouseup and click, matching real Chromium event delivery.
		await Promise.resolve();
		act(() => {
			nav.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(copyItem()).toBeNull();
		expect(host.querySelector("nav.pathbar input")).toBeNull();
		expect(onCopyPath).not.toHaveBeenCalled();
	});

	it("allows opening the editor after dismissing the copy menu by clicking elsewhere", () => {
		const onCopyPath = vi.fn();
		render(onCopyPath);
		rightClick(segment("Work"));
		expect(copyItem()).not.toBeNull();
		// Click outside the bar to dismiss the menu.
		act(() => {
			document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(copyItem()).toBeNull();
		// A subsequent click on the empty bar should still open the path editor.
		act(() => {
			host.querySelector<HTMLElement>("nav.pathbar")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(host.querySelector("nav.pathbar input")).not.toBeNull();
	});
	it("does not intercept right-click when the path editor is open", () => {
		const onCopyPath = vi.fn();
		render(onCopyPath);
		act(() => {
			host.querySelector<HTMLElement>("nav.pathbar")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const input = host.querySelector<HTMLInputElement>("nav.pathbar input")!;
		expect(input).not.toBeNull();
		const event = rightClick(input);
		expect(event.defaultPrevented).toBe(false);
		expect(copyItem()).toBeNull();
	});

	it("copies a Windows drive root from the volume segment", () => {
		const onCopyPath = vi.fn();
		const winPath = "C:\\Users\\jeffrey\\Documents";
		render(onCopyPath, { path: winPath });
		rightClick(segment("C:"));
		choose();
		expect(onCopyPath).toHaveBeenCalledExactlyOnceWith("C:\\");
	});

	it("offers Copy Path even on a non-folder item folded into the dropdown", () => {
		// Fold everything except the last segment, including Macintosh HD (which has path: null).
		viewportWidth = 110;
		const onCopyPath = vi.fn();
		render(onCopyPath);
		act(() => host.querySelector<HTMLElement>("nav.pathbar .path-trail [data-path-more]")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const volume = [...document.querySelectorAll<HTMLElement>('[role="menuitem"][data-copy-path]')].find((item) => item.textContent === "Macintosh HD");
		expect(volume).not.toBeUndefined();
		// A disabled <button> does not receive pointer events in real browsers, so a non-navigable item must still accept right-click.
		expect((volume as HTMLButtonElement).disabled).toBe(false);
		rightClick(volume!);
		choose();
		expect(onCopyPath).toHaveBeenCalledExactlyOnceWith(PATH);
	});
});
