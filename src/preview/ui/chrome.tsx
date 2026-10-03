import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { QuickLookWindowBridge } from "../shared/contract";
import type { QuickLookFit, Size } from "../shared/fit";

/**
 * What a viewer can reach of the window around it: the toolbar slot where its
 * own controls go (the reference puts segmented views, wrap, and copy there),
 * and the size it would like the window to take.
 */
export interface QuickLookChrome {
	readonly bridge: QuickLookWindowBridge;
	/** Portal target between the file name and the share button. */
	readonly toolbar: HTMLElement | null;
	/** The size the panel body wants. Only the first report of a load sizes the window. */
	readonly report: (size: Size, fit: QuickLookFit) => void;
	/** Resizes the window again after the first report, for a change the user asked for. */
	readonly resize: (size: Size) => void;
	/** Panels that print the name themselves (folders, unknown files) leave the toolbar title empty. */
	readonly hideTitle: (hidden: boolean) => void;
	/** The app "Open with" launches, when known. */
	readonly app: string | null;
}

const ChromeContext = createContext<QuickLookChrome | null>(null);

export const ChromeProvider = ChromeContext.Provider;

export function useChrome(): QuickLookChrome {
	const chrome = useContext(ChromeContext);
	if (chrome === null) throw new Error("Quick Look viewers render inside ChromeProvider");
	return chrome;
}

/** Renders `children` into the toolbar, right of the file name. */
export function ToolbarSlot({ children }: { readonly children: ReactNode }): ReactElement | null {
	const { toolbar } = useChrome();
	return toolbar === null ? null : createPortal(children, toolbar);
}

/** Leaves the toolbar title empty while the calling panel is shown. */
export function useHiddenTitle(): void {
	const { hideTitle } = useChrome();
	useEffect(() => {
		hideTitle(true);
		return () => hideTitle(false);
	}, [hideTitle]);
}

/**
 * Sizes the window to a fixed-width panel by its laid-out height, and follows
 * the panel when it grows or shrinks afterwards (the 자세한 정보 disclosure).
 * Returns the ref callback for the panel's root.
 */
export function usePanelHeight(width: number): (node: HTMLElement | null) => void {
	const { report, resize } = useChrome();
	const [node, setNode] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (node === null) return;
		let last = 0;
		const observer = new ResizeObserver(() => {
			const height = Math.ceil(node.offsetHeight);
			if (height === last || height === 0) return;
			const first = last === 0;
			last = height;
			if (first) report({ width, height }, "clamp");
			else resize({ width, height });
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [node, width, report, resize]);
	return setNode;
}

const SEGMENT =
	"flex items-center gap-5 h-24 px-10 border-0 rounded-6 bg-transparent text-ql-ink-secondary font-ql text-[12px] font-medium cursor-default aria-pressed:bg-ql-highlight aria-pressed:text-ql-ink aria-pressed:shadow-ql-segment [-webkit-app-region:no-drag]";

export interface SegmentOption<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly icon?: ReactElement;
}

/** The toolbar's segmented view switch (원본 · 나란히 · 렌더링, 데스크톱 · 모바일 · 소스). */
export function Segmented<T extends string>({
	label,
	options,
	value,
	onChange,
}: {
	readonly label: string;
	readonly options: readonly SegmentOption<T>[];
	readonly value: T;
	readonly onChange: (value: T) => void;
}): ReactElement {
	return (
		<div className="ql-seg flex gap-2 mr-4 p-2 rounded-8 bg-ql-button" role="group" aria-label={label}>
			{options.map((option) => (
				<button key={option.value} type="button" className={SEGMENT} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
					{option.icon}
					{option.label}
				</button>
			))}
		</div>
	);
}

/** A 28px round-cornered toolbar icon button; `pressed` tints it with the accent. */
export const TOOL_BUTTON =
	"ql-tool grid flex-none place-items-center w-28 h-28 p-0 border-0 rounded-7 bg-transparent text-ql-ink-secondary cursor-default hover:bg-ql-button aria-pressed:bg-ql-button aria-pressed:text-ql-accent focus-visible:outline-2 focus-visible:outline-ql-accent [-webkit-app-region:no-drag]";

/** The small filled toolbar button (복사). */
export const SMALL_BUTTON =
	"flex flex-none items-center gap-5 h-24 px-9 border-0 rounded-6 bg-ql-button text-ql-ink font-ql text-[12px] font-medium cursor-default hover:bg-ql-button-hover [-webkit-app-region:no-drag]";
