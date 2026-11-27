/**
 * The automations that watch the folder a person is looking at, in the Info
 * half's card idiom: a "자동화" header, then one card per rule with its last
 * run and a ⋯ button whose dropdown edits or deletes the rule, then (for a file) the right-click actions that ran
 * on it, each with its newest run there. Right click on
 * a card opens the rule's full menu at the pointer.
 *
 * The filtering happens at the call site — this renders the rules it is given.
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationRule, AutomationRun } from "../../../shared/automation-contract";
import type { MagicAction } from "../../../shared/context-menu-contract";
import { cn } from "../lib/cn";
import { relativeTime, ruleTitle, runTone } from "../state/automations";
import { MoreIcon, MousePointerClickIcon, NewChatIcon, ZapIcon } from "./icons";

/** A right-click action that ran on the file in the inspector, with its newest run on that file. */
export interface MagicActionOnFile {
	readonly action: MagicAction;
	readonly run: AutomationRun;
}

export interface AutomationRulesSectionProps {
	readonly rules: readonly AutomationRule[];
	readonly onEdit: (rule: AutomationRule) => void;
	readonly onDelete: (rule: AutomationRule) => void;
	/** Right click on a row: its menu, at the pointer. Absent leaves the browser's menu alone. */
	readonly onMenu?: ((rule: AutomationRule, at: { readonly x: number; readonly y: number }) => void) | undefined;
	/** Right-click actions that ran on this file, drawn as rule rows with the click glyph (a rule's is the bolt). */
	readonly magic?: {
		readonly items: readonly MagicActionOnFile[];
		readonly onEdit: (id: string) => void;
		readonly onDelete: (id: string) => void;
		/** A click on a card: that run's result, in the dialog a live run ends in. */
		readonly onOpen?: ((item: MagicActionOnFile) => void) | undefined;
	};
}

export function AutomationRulesSection({ rules, onEdit, onDelete, onMenu, magic }: AutomationRulesSectionProps): ReactElement | null {
	const { t } = useTranslation();
	const magicItems = magic?.items ?? [];
	if (rules.length === 0 && magicItems.length === 0) return null;
	return (
		<div className="info-section automation-section flex flex-col gap-8 border-t border-divider pt-8">
			<div className="section-title flex h-22 items-center">
				<span className="text-meta font-medium leading-[16px] text-ink">{t("automations.inspector.folderSection")}</span>
			</div>
			<div className="flex flex-col gap-4">
				{rules.map((rule) => (
					<AutomationRow
						key={rule.id}
						title={ruleTitle(rule)}
						glyph={<ZapIcon size={14} />}
						run={rule.lastRun}
						onEdit={() => onEdit(rule)}
						onDelete={() => onDelete(rule)}
						onMenu={onMenu === undefined ? undefined : (at) => onMenu(rule, at)}
					/>
				))}
				{magic === undefined
					? null
					: magicItems.map(({ action, run }) => (
							<AutomationRow
								key={`magic-${action.id}`}
								magicId={action.id}
								onOpen={magic.onOpen === undefined ? undefined : () => magic.onOpen?.({ action, run })}
								title={action.label}
								glyph={<MousePointerClickIcon size={14} />}
								run={run}
								onEdit={() => magic.onEdit(action.id)}
								onDelete={() => magic.onDelete(action.id)}
								onMenu={undefined}
							/>
						))}
			</div>
		</div>
	);
}

function AutomationRow({
	title,
	glyph,
	run,
	magicId,
	onOpen,
	onEdit,
	onDelete,
	onMenu,
}: {
	readonly title: string;
	readonly glyph: ReactNode;
	readonly run: AutomationRun | null;
	readonly magicId?: string;
	/** A click on the card: a right-click action's opens the result of its run on this file. */
	readonly onOpen?: (() => void) | undefined;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
	readonly onMenu: ((at: { readonly x: number; readonly y: number }) => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const tone = runTone(run);
	// Figma 593:2784: a 4px dot in the run's colour, then the run in muted words.
	const runText =
		run === null
			? t("automations.inspector.notRun")
			: tone === "ok"
				? t("automations.inspector.ranOk", { time: relativeTime(run.startedAt) })
				: t("automations.inspector.ranFail", { time: relativeTime(run.startedAt) });
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onMouseDown = (event: MouseEvent): void => {
			if (event.target instanceof Node && ref.current?.contains(event.target) === true) return;
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", onMouseDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
	const choose = (action: () => void): void => {
		setOpen(false);
		action();
	};
	return (
		<div
			ref={ref}
			className={cn("rule-row relative flex w-full items-center gap-12 rounded-10 border border-border bg-window py-8 pl-12 pr-10", onOpen !== undefined && "hover:bg-hover-row")}
			data-inspector-magic={magicId}
			onContextMenu={(event) => {
				if (onMenu === undefined) return;
				event.preventDefault();
				onMenu({ x: event.clientX, y: event.clientY });
			}}
		>
			{/* The whole card opens the run's result; the ⋯ button sits above it and keeps its own click. */}
			{onOpen === undefined ? null : (
				<button type="button" data-action="open-run-result" className="absolute inset-0 cursor-pointer rounded-10 border-0 bg-transparent p-0" aria-label={title} title={t("automations.inspector.openResult")} onClick={onOpen} />
			)}
			<span className="pointer-events-none flex flex-none text-accent-text" aria-hidden="true">
				{glyph}
			</span>
			<span className="pointer-events-none flex min-w-0 flex-1 flex-col gap-2">
				<span className="truncate text-meta font-medium leading-[16px] text-ink">{title}</span>
				<span className="flex min-w-0 items-center gap-4" data-run-tone={tone}>
					<span
						className={cn("size-4 flex-none rounded-full", tone === "ok" ? "bg-[var(--ok-dot)]" : tone === "fail" ? "bg-danger-dot" : "bg-[var(--text-faint)]")}
						aria-hidden="true"
					/>
					<span className="truncate text-badge leading-[16px] text-ink-muted">{runText}</span>
				</span>
			</span>
			<button
				type="button"
				className={cn("relative flex size-20 flex-none items-center justify-center rounded-5 border-0 p-0 text-ink-body cursor-pointer hover:bg-hover", open ? "bg-hover" : "bg-transparent")}
				aria-label={t("automations.inspector.more")}
				title={t("automations.inspector.more")}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				<MoreIcon size={16} />
			</button>
			{open ? (
				<div
					className="menu absolute right-6 top-full z-30 mt-4 flex w-120 flex-col rounded-10 border border-border bg-window p-4 shadow-[0_6px_18px_rgba(0,0,0,0.16)] animate-[rise_var(--dur-menu)_var(--ease-out)]"
					role="menu"
					aria-label={title}
				>
					<button
						type="button"
						role="menuitem"
						className="menu__item flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-10 text-left text-[13px] text-ink whitespace-nowrap cursor-pointer hover:bg-hover"
						onClick={() => choose(onEdit)}
					>
						<NewChatIcon size={13} />
						{t("automations.inspector.menuEdit")}
					</button>
					<button
						type="button"
						role="menuitem"
						className="menu__item flex h-28 items-center gap-8 rounded-6 border-0 bg-transparent px-10 text-left text-[13px] text-danger-text whitespace-nowrap cursor-pointer hover:bg-hover"
						onClick={() => choose(onDelete)}
					>
						{t("automations.inspector.menuDelete")}
					</button>
				</div>
			) : null}
		</div>
	);
}
