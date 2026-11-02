// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReduceSizeDialog } from "../src/renderer/src/components/primitives/ReduceSizeDialog";
import type { ReduceSizeDialogState } from "../src/renderer/src/state/reduce-size-dialog";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	void setAppLanguage("ko");
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const BASE: ReduceSizeDialogState = {
	id: "reduce-1",
	path: "/Users/test/k-skill-ai-rookie.mp4",
	name: "k-skill-ai-rookie.mp4",
	size: 174_063_616,
	kind: "video",
	level: "balanced",
	replaceOriginal: true,
	working: false,
	percent: null,
};

describe("ReduceSizeDialog", () => {
	it("lets the user pick compression strength and replace-vs-copy before starting", () => {
		const onChangeLevel = vi.fn();
		const onChangeReplace = vi.fn();
		const onStart = vi.fn();
		const onCancel = vi.fn();

		act(() =>
			root.render(
				<ReduceSizeDialog
					state={BASE}
					onChangeLevel={onChangeLevel}
					onChangeReplaceOriginal={onChangeReplace}
					onStart={onStart}
					onCancel={onCancel}
				/>,
			),
		);

		expect(host.textContent).toContain("k-skill-ai-rookie.mp4");
		expect(host.textContent).toContain("166 MB");
		const maxOption = host.querySelector<HTMLButtonElement>('[data-level="max"]');
		expect(maxOption).not.toBeNull();
		act(() => maxOption?.click());
		expect(onChangeLevel).toHaveBeenCalledWith("max");

		const copyOption = host.querySelector<HTMLButtonElement>('[data-output-mode="copy"]');
		expect(copyOption).not.toBeNull();
		act(() => copyOption?.click());
		expect(onChangeReplace).toHaveBeenCalledWith(false);

		const startButton = host.querySelector<HTMLButtonElement>('[data-action="confirm-reduce"]');
		expect(startButton).not.toBeNull();
		act(() => startButton?.click());
		expect(onStart).toHaveBeenCalledTimes(1);
	});

	it("previews the single -reduced copy name when copy mode is chosen", () => {
		act(() =>
			root.render(
				<ReduceSizeDialog
					state={{ ...BASE, replaceOriginal: false }}
					onChangeLevel={() => {}}
					onChangeReplaceOriginal={() => {}}
					onStart={() => {}}
					onCancel={() => {}}
				/>,
			),
		);
		expect(host.textContent).toContain("k-skill-ai-rookie-reduced.mp4");
	});

	it("turns into a live progress card with percentage and Cancel while working", () => {
		const onCancel = vi.fn();
		act(() =>
			root.render(
				<ReduceSizeDialog
					state={{ ...BASE, working: true, percent: 42 }}
					onChangeLevel={() => {}}
					onChangeReplaceOriginal={() => {}}
					onStart={() => {}}
					onCancel={onCancel}
				/>,
			),
		);

		const bar = host.querySelector('[role="progressbar"]');
		expect(bar).not.toBeNull();
		expect(bar?.getAttribute("aria-valuenow")).toBe("42");
		expect(host.textContent).toContain("42%");
		expect(host.querySelector('[data-action="confirm-reduce"]')).toBeNull();

		const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
			(button.textContent ?? "").includes("취소"),
		);
		expect(cancel).toBeDefined();
		act(() => cancel?.click());
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
