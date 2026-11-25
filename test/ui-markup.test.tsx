// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentEditEvent, DocumentEditRequest } from "../src/preview/shared/annotation";
import type { QuickLookWindowBridge } from "../src/preview/shared/contract";
import { MarkupLayer } from "../src/preview/ui/markup";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Harness {
	readonly requests: Array<{ readonly runId: string; readonly request: DocumentEditRequest }>;
	readonly undone: string[];
	readonly textEntries: boolean[];
	readonly cancelled: string[];
	emit(event: DocumentEditEvent): void;
	finish(): void;
}

function bridgeFor(harness: { requests: Harness["requests"]; undone: string[]; textEntries: boolean[]; cancelled: string[]; listeners: Set<(event: DocumentEditEvent) => void>; release: Array<() => void> }): QuickLookWindowBridge {
	return {
		editDocument: (runId: string, request: DocumentEditRequest) => {
			harness.requests.push({ runId, request });
			const { promise, resolve } = Promise.withResolvers<void>();
			harness.release.push(resolve);
			return promise;
		},
		cancelEdit: async (runId: string) => {
			harness.cancelled.push(runId);
		},
		undoEdit: async (runId: string) => {
			harness.undone.push(runId);
			return true;
		},
		onEditEvent: (listener: (event: DocumentEditEvent) => void) => {
			harness.listeners.add(listener);
			return () => harness.listeners.delete(listener);
		},
		textEntry: (active: boolean) => {
			harness.textEntries.push(active);
		},
	} as unknown as QuickLookWindowBridge;
}

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
	({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

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
	vi.restoreAllMocks();
	await setAppLanguage("ko");
});

/** A stage at (0,46) 800x600 holding page 2 at (100,100) 400x500, like a paged viewer. */
async function mount(): Promise<Harness> {
	const state = { requests: [] as Harness["requests"], undone: [] as string[], textEntries: [] as boolean[], cancelled: [] as string[], listeners: new Set<(event: DocumentEditEvent) => void>(), release: [] as Array<() => void> };
	const bridge = bridgeFor(state);
	function Stage(): React.ReactElement {
		const stageRef = useRef<HTMLElement | null>(null);
		return (
			<>
				<main
					ref={(element) => {
						stageRef.current = element;
						if (element !== null) element.getBoundingClientRect = () => rect(0, 46, 800, 600);
					}}
				>
					<div
						data-page="2"
						ref={(element) => {
							if (element !== null) element.getBoundingClientRect = () => rect(100, 100, 400, 500);
						}}
					>
						<p>출시일: 11월 15일</p>
					</div>
				</main>
				<MarkupLayer bridge={bridge} path="/docs/plan.docx" seq={1} stageRef={stageRef} onExit={() => undefined} />
			</>
		);
	}
	await act(async () => {
		root.render(<Stage />);
	});
	const page = host.querySelector<HTMLElement>("[data-page]");
	document.elementsFromPoint = () => (page === null ? [] : [page]);
	return {
		requests: state.requests,
		undone: state.undone,
		textEntries: state.textEntries,
		cancelled: state.cancelled,
		emit: (event) => act(() => state.listeners.forEach((listener) => listener(event))),
		finish: () => state.release.forEach((resolve) => resolve()),
	};
}

function pointer(target: Element, type: string, x: number, y: number): void {
	target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
}

async function drawBox(from: [number, number], to: [number, number]): Promise<void> {
	const layer = host.querySelector("svg.ql-markup");
	if (layer === null) throw new Error("no drawing layer");
	await act(async () => pointer(layer, "pointerdown", ...from));
	await act(async () => pointer(layer, "pointermove", ...to));
	await act(async () => pointer(layer, "pointerup", ...to));
}

function button(name: string): HTMLButtonElement {
	const found = [...host.querySelectorAll("button")].find((element) => element.textContent === name || element.getAttribute("aria-label") === name);
	if (found === undefined) throw new Error(`no button ${name}`);
	return found;
}

async function typeInstruction(text: string): Promise<HTMLTextAreaElement> {
	const field = host.querySelector("textarea");
	if (field === null) throw new Error("no instruction field");
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
	return field;
}

/** Takes the composer off the page, the way switching files or closing the window does. */
async function closeComposer(): Promise<void> {
	await act(async () => {
		root.render(null);
	});
}

describe("Quick Look markup", () => {
	it("sends a box drawn on a page as fractions of that page, with the instruction", async () => {
		const harness = await mount();
		await act(async () => button("Box").click());
		await drawBox([140, 150], [340, 200]);
		expect(host.querySelectorAll("[data-mark=box]")).toHaveLength(1);
		expect(host.textContent).toContain("Marks: 1");

		const field = await typeInstruction("이 문단을 지워줘");
		await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

		expect(harness.requests).toHaveLength(1);
		const { request } = harness.requests[0] ?? { request: null };
		expect(request?.path).toBe("/docs/plan.docx");
		expect(request?.instruction).toBe("이 문단을 지워줘");
		expect(request?.marks).toEqual([{ tool: "box", page: 2, text: expect.any(String), points: [{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.2 }] }]);
		expect(host.querySelector("[data-edit-state=running]")).not.toBeNull();
		expect((host.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
	});

	it("does not keep a click without a drag as a mark", async () => {
		await mount();
		await drawBox([200, 200], [201, 201]);
		expect(host.querySelectorAll("[data-mark]")).toHaveLength(0);
	});

	it("shows the reply when the edit lands and rolls it back with Undo", async () => {
		const harness = await mount();
		await drawBox([140, 150], [340, 200]);
		const field = await typeInstruction("굵게");
		await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		const runId = harness.requests[0]?.runId ?? "";

		harness.emit({ type: "progress", runId, text: "문서를 여는 중" });
		expect(host.textContent).toContain("문서를 여는 중");
		harness.emit({ type: "done", runId, path: "/docs/plan.docx", changed: true, reply: "굵게 바꿨습니다." });
		await act(async () => harness.finish());
		expect(host.querySelector("[data-edit-state=changed]")?.textContent).toContain("굵게 바꿨습니다.");

		await act(async () => button("Undo Edit").click());
		expect(harness.undone).toEqual([runId]);
	});

	it("ignores events of another run", async () => {
		const harness = await mount();
		const field = await typeInstruction("고쳐줘");
		await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		harness.emit({ type: "error", runId: "someone-else", message: "boom" });
		expect(host.querySelector("[data-edit-state=running]")).not.toBeNull();
	});

	it("hands the keyboard back when the composer goes while its field is focused", async () => {
		const harness = await mount();
		const field = await typeInstruction("고쳐줘");
		await act(async () => {
			field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		});
		expect(harness.textEntries).toContain(true);

		await closeComposer();
		expect(harness.textEntries.at(-1)).toBe(false);
	});

	it("cancels a run that was still live when the composer goes away", async () => {
		const harness = await mount();
		const field = await typeInstruction("고쳐줘");
		await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		const runId = harness.requests[0]?.runId ?? "";
		expect(host.querySelector("[data-edit-state=running]")).not.toBeNull();

		await closeComposer();
		expect(harness.cancelled).toEqual([runId]);
	});
});
