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

function render(onCopyPath: (path: string) => void, withFile = false): void {
	act(() =>
		root.render(
			<PathBar
				path={PATH}
				crumbs={breadcrumbTrail(PATH, Number.MAX_SAFE_INTEGER)}
				selectedName={withFile ? "report.pdf" : null}
				selectedPath={withFile ? FILE : null}
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
		render(onCopyPath, true);
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
});
