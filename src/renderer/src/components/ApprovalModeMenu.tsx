/**
 * The approval-mode pill inside the composer (librarian v2.12). It shows the
 * mode now in force — Ask / Auto / Full — and opens a small menu to change it.
 * Nothing runs through it: the panel reads the initial mode with
 * `interaction.getMode()`, changes it with `setMode()`, and keeps every window's
 * pill in sync through `onMode`.
 *
 * Reuses the repo's existing popover pattern — the same `.menu` marker surface,
 * `menuPlacement` math, and `menuitemradio` rows as `ToolbarMenu` — rather than
 * inventing a second one.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ShieldAlert, ShieldCheck, ShieldQuestion, type LucideIcon } from "lucide-react";
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE, type ApprovalMode } from "../../../shared/interaction-contract";
import { cn } from "../lib/cn";
import { menuPlacement } from "../state/context-menu";
import { modeDescriptionKey, modeLabelKey } from "../state/interaction";
import { CheckIcon } from "./icons";

/** Mirrors --w-interaction-menu (w-context-menu is too narrow for the mode descriptions); the placement math needs the number. */
const MENU_WIDTH = 316;
/** A mode row: the label line plus its description. */
const MENU_ROW_HEIGHT = 64;

const MODE_ICON: Record<ApprovalMode, LucideIcon> = {
	ask: ShieldQuestion,
	auto: ShieldCheck,
	full: ShieldAlert,
};

function triggerTone(mode: ApprovalMode): string {
	return mode === "full" ? "bg-warn-bg text-warn-text hover:bg-warn-bg-strong" : "bg-selected-nav text-ink-body hover:bg-hover-strong";
}

export interface ApprovalModeMenuProps {
	readonly mode: ApprovalMode;
	/** Persists the mode; the panel shows the mode `setMode` resolves to. */
	readonly onChange: (mode: ApprovalMode) => void;
}

/**
 * The mode a pill reads and writes: the stored value via `getMode`, every change
 * another window or the main process makes via `onMode`, and a `setMode` that
 * adopts the mode the main process resolved to rather than the one requested.
 * `auto` shows until the first read answers.
 */
export function useApprovalMode(): { readonly mode: ApprovalMode; readonly setMode: (mode: ApprovalMode) => void } {
	const [mode, setModeState] = useState<ApprovalMode>(DEFAULT_APPROVAL_MODE);
	useEffect(() => {
		const bridge = window.autorag?.interaction;
		if (bridge === undefined) return;
		let alive = true;
		void bridge.getMode().then((value) => {
			if (alive) setModeState(value);
		});
		const unsubscribe = bridge.onMode((value) => setModeState(value));
		return () => {
			alive = false;
			unsubscribe();
		};
	}, []);
	const setMode = (next: ApprovalMode): void => {
		const bridge = window.autorag?.interaction;
		if (bridge === undefined) {
			setModeState(next);
			return;
		}
		void bridge.setMode(next).then((applied) => setModeState(applied));
	};
	return { mode, setMode };
}

export function ApprovalModeMenu({ mode, onChange }: ApprovalModeMenuProps): ReactElement {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const CurrentIcon = MODE_ICON[mode];

	useEffect(() => {
		if (!open) return;
		const node = menuRef.current;
		(node?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? node?.querySelector<HTMLButtonElement>("button"))?.focus();
		const outside = (event: PointerEvent): void => {
			if (event.target instanceof Node && (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target))) return;
			setOpen(false);
		};
		const onResize = (): void => setOpen(false);
		window.addEventListener("pointerdown", outside);
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("pointerdown", outside);
			window.removeEventListener("resize", onResize);
		};
	}, [open]);

	const choose = (option: ApprovalMode): void => {
		setOpen(false);
		triggerRef.current?.focus();
		if (option !== mode) onChange(option);
	};

	const rect = triggerRef.current?.getBoundingClientRect();
	const height = APPROVAL_MODES.length * MENU_ROW_HEIGHT + 8;
	const placement = menuPlacement(
		{ x: rect?.left ?? 0, y: rect?.bottom ?? 0 },
		{ width: MENU_WIDTH, height },
		{ width: window.innerWidth, height: window.innerHeight },
	);

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className={cn(
					"inline-flex h-26 flex-none items-center gap-4 rounded-full border-0 px-8 text-badge font-medium cursor-pointer transition-colors duration-(--dur-color) ease-out",
					triggerTone(mode),
				)}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t("interaction.mode.triggerAria")}
				title={t("interaction.mode.triggerAria")}
				onClick={() => setOpen((current) => !current)}
				onKeyDown={(event) => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					setOpen(true);
				}}
			>
				<CurrentIcon size={13} />
				<span>{t(modeLabelKey(mode))}</span>
				<ChevronDown size={11} />
			</button>

			{open ? (
				<div
					ref={menuRef}
					className="menu fixed z-60 flex w-interaction-menu flex-col overflow-y-auto rounded-10 border border-border bg-window p-4 shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
					role="menu"
					aria-label={t("interaction.mode.menuLabel")}
					style={{ left: placement.left, top: placement.top, maxHeight: window.innerHeight - 16 }}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "Escape") {
							event.preventDefault();
							setOpen(false);
							triggerRef.current?.focus();
							return;
						}
						if (event.key === "Tab") {
							setOpen(false);
							return;
						}
						if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
						event.preventDefault();
						const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
						const index = items.indexOf(document.activeElement as HTMLButtonElement);
						const next =
							event.key === "Home"
								? 0
								: event.key === "End"
									? items.length - 1
									: (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
						items[next]?.focus();
					}}
				>
					{APPROVAL_MODES.map((option) => {
						const Icon = MODE_ICON[option];
						const selected = option === mode;
						return (
							<button
								key={option}
								type="button"
								role="menuitemradio"
								aria-checked={selected}
								tabIndex={-1}
								className={cn(
									"flex w-full items-start gap-8 rounded-6 border-0 bg-transparent px-10 py-8 text-left transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover focus:bg-hover focus:outline-none",
									option === "full" ? "text-warn-text" : "text-ink",
								)}
								onClick={() => choose(option)}
							>
								<span className="flex size-16 flex-none items-center justify-center pt-1">
									{selected ? <CheckIcon /> : null}
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-5 text-sm font-medium">
										<Icon size={13} />
										{t(modeLabelKey(option))}
									</span>
									<span className="mt-2 block text-badge font-normal leading-[1.4] text-ink-muted">{t(modeDescriptionKey(option))}</span>
								</span>
							</button>
						);
					})}
				</div>
			) : null}
		</>
	);
}
