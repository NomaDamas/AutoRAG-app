// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toolbar } from "../src/renderer/src/components/Toolbar";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	setAppLanguage("en");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function renderToolbar(onApplySort = vi.fn(), shareAvailable = false, inspectorHidden = false): void {
	act(() =>
		root.render(
			<Toolbar
				title="Docs"
				canGoBack={false}
				canGoForward={false}
				onBack={() => {}}
				onForward={() => {}}
				viewMode="list"
				onViewModeChange={() => {}}
				sort={null}
				grouping="none"
				onApplySort={onApplySort}
				onSetGrouping={() => {}}
				inspectorHidden={inspectorHidden}
				onShowInspector={() => {}}
				shareAvailable={shareAvailable}
				canShare={false}
				onShare={() => {}}
				trashActive={false}
				canPutBack={false}
				onPutBack={() => {}}
				onEmptyTrash={() => {}}
				sidebarHidden={false}
				onShowSidebar={() => {}}
			/>,
		),
	);
}

const control = (label: string): HTMLButtonElement => {
	const button = host.querySelector<HTMLButtonElement>(`.toolbar__control[aria-label="${label}"]`);
	if (button === null) throw new Error(`no ${label} control`);
	return button;
};

describe("Toolbar Sort/Group menu", () => {
	it("returns focus to the control that opened the menu on every open, not just the first", () => {
		const errors: unknown[] = [];
		const onError = (event: ErrorEvent): void => {
			errors.push(event.error);
			event.preventDefault();
		};
		window.addEventListener("error", onError);
		try {
			renderToolbar();
			const click = (element: Element): void => {
				act(() => {
					element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
				});
			};
			// React evaluates the first `setMenu` updater inside the click; later ones
			// run during render, when the event's `currentTarget` is already null.
			for (const label of ["Sort", "Group", "Sort", "Group"]) {
				const opener = control(label);
				click(opener);
				const item = host.querySelector<HTMLButtonElement>('[role="menuitemradio"]');
				expect(item, `${label} menu opens`).not.toBeNull();
				if (item !== null) click(item);
				expect(errors, `${label} menu closes without throwing`).toEqual([]);
				expect(document.activeElement, `${label} control regains focus`).toBe(opener);
			}
		} finally {
			window.removeEventListener("error", onError);
		}
	});
});

describe("Toolbar right cluster", () => {
	// AI Search is reached from the sidebar and ⌘K; the toolbar carries no toggle for it.
	const clusterLabels = (): (string | null)[] =>
		[...host.querySelectorAll(".tgroup button")].map((button) => button.getAttribute("aria-label"));

	it("holds Share, and no inspector or AI Search toggle, while the inspector is shown", () => {
		renderToolbar(vi.fn(), true);
		expect(clusterLabels()).toEqual(["Share"]);
		// The inspector hides from its own head, like the left sidebar; the toolbar stops at its edge.
		expect(host.querySelector('[aria-label="Show inspector"]')).toBeNull();
		expect(host.querySelector('[aria-label="Hide inspector"]')).toBeNull();
		expect(host.querySelector('[aria-label="Show AI Search"]')).toBeNull();
		expect(host.querySelector('[title^="AI Search"]')).toBeNull();
	});

	it("holds nothing where the OS has no share sheet", () => {
		renderToolbar();
		expect(clusterLabels()).toEqual([]);
	});

	it("ends with the show-inspector button only while the inspector is hidden, mirroring the show-sidebar button", () => {
		renderToolbar(vi.fn(), true, true);
		const labels = [...host.querySelectorAll(".toolbar button")].map((button) => button.getAttribute("aria-label"));
		expect(labels.at(-1)).toBe("Show inspector");
		expect(clusterLabels()).toEqual(["Share"]);
	});
});
