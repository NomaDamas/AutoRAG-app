/**
 * The 언제 sentence for a right-click (the 자동화 card when its trigger is 우클릭하면, and the 매직액션 modal):
 * "[PDF 파일 ▾] [하나 ▾] 를 우클릭하면". The file-kind chip also takes a typed extension. `event` is the trigger word: the
 * card passes its trigger chip, the modal passes nothing and the word is plain text, since there it cannot change.
 */

import { Fragment, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { MagicAction, MagicActionSelectionRule } from "../../../shared/context-menu-contract";
import { normalizeExtensionList } from "../../../shared/context-menu-contract";
import { cn } from "../lib/cn";
import { RIGHT_CLICK_KINDS, SELECTIONS, rightClickKindOf, type RightClickKind } from "../state/right-click-trigger";
import { ChipSelect, type ChipOption } from "./primitives/ChipSelect";

export function RightClickWhen({
	kind,
	custom,
	selection,
	event,
	onKind,
	onCustom,
	onSelection,
	testId,
	className = "flex flex-wrap items-center gap-8 py-4",
}: {
	readonly kind: RightClickKind;
	/** A typed extension list; while it is set the chip names it instead of `kind`. */
	readonly custom: readonly string[] | null;
	readonly selection: MagicActionSelectionRule;
	/** The trigger chip; without one the trigger reads as plain text. */
	readonly event?: ReactNode;
	readonly onKind: (kind: RightClickKind) => void;
	readonly onCustom: (extensions: readonly string[]) => void;
	readonly onSelection: (selection: MagicActionSelectionRule) => void;
	readonly testId: string;
	/** The sentence row's layout, so it can sit in the same rhythm as the sentence it replaces. */
	readonly className?: string;
}): ReactElement {
	const { t } = useTranslation();
	const [typed, setTyped] = useState("");
	const kinds: readonly ChipOption<RightClickKind>[] = RIGHT_CLICK_KINDS.map((value) => ({
		value,
		label: t(`rightClickWhen.kind.${value}`),
		divided: value === "folder",
	}));
	const counts: readonly ChipOption<MagicActionSelectionRule>[] = SELECTIONS.map((value) => ({ value, label: t(`rightClickWhen.count.${value}`) }));
	const customLabel = custom === null ? null : t("rightClickWhen.custom", { exts: custom.map((ext) => ext.toUpperCase()).join("/") });
	const chips: Readonly<Record<string, ReactNode>> = {
		kind: (
			<ChipSelect
				value={custom === null ? kind : null}
				options={kinds}
				label={customLabel ?? t("rightClickWhen.kindLabel")}
				testId={`${testId}-kind`}
				onChange={onKind}
				footer={(close) => (
					<input
						data-testid={`${testId}-ext`}
						value={typed}
						placeholder={t("rightClickWhen.extPlaceholder")}
						aria-label={t("rightClickWhen.extPlaceholder")}
						className="h-26 w-full min-w-[180px] rounded-6 border-[0.5px] border-divider bg-window px-8 text-meta text-ink outline-none placeholder:text-ink-faint focus:border-accent"
						onChange={(change) => setTyped(change.target.value)}
						onKeyDown={(key) => {
							key.stopPropagation();
							if (key.key !== "Enter") return;
							key.preventDefault();
							const list = normalizeExtensionList(typed);
							if (list.length === 0) return;
							onCustom(list);
							setTyped("");
							close();
						}}
					/>
				)}
			/>
		),
		count: <ChipSelect value={selection} options={counts} label={t("rightClickWhen.countLabel")} testId={`${testId}-count`} onChange={onSelection} />,
		event: event ?? (
			<span className="text-meta leading-[18px] text-ink" data-testid={`${testId}-event`}>
				{t("rightClickWhen.event")}
			</span>
		),
	};
	// The word order is the language's: the chips sit where its {{kind}}, {{count}} and {{event}} are.
	const sentence = t(`rightClickWhen.sentence.${selection}`, { kind: "\u0000kind\u0000", count: "\u0000count\u0000", event: "\u0000event\u0000" }).split("\u0000");
	return (
		<div className={className} data-testid={`${testId}-when`}>
			{sentence.map((part, index) =>
				part in chips ? (
					<Fragment key={index}>{chips[part]}</Fragment>
				) : part.trim().length === 0 ? null : (
					<span key={index} className="text-meta leading-[18px] text-ink-muted">
						{part.trim()}
					</span>
				),
			)}
		</div>
	);
}

/** Whether an action asks the agent or runs a command; set when it is made, never picked in a form. */
export type RunKind = "agent" | "script";

/** The 언제 sentence of a saved action as plain text ("PDF 파일 하나를 우클릭하면"), for a row that lists it. */
export function rightClickSentence(t: TFunction, action: Pick<MagicAction, "selection" | "targetKind" | "extensions">): string {
	const { kind, custom } = rightClickKindOf(action.targetKind, action.extensions);
	const kindLabel = custom === null ? t(`rightClickWhen.kind.${kind}`) : t("rightClickWhen.custom", { exts: custom.map((ext) => ext.toUpperCase()).join("/") });
	return t(`rightClickWhen.sentence.${action.selection}`, { kind: kindLabel, count: t(`rightClickWhen.count.${action.selection}`), event: t("rightClickWhen.event") });
}
