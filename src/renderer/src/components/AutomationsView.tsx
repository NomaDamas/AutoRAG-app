/**
 * The AI 에이전트 tab's 자동화 side (Figma 672:3718, 672:3740, 676:646, 676:790), one centred column in three places:
 * - the list: with no rules, 내 파일에서 찾은 자동화 (recommendations that open to show what they would do, and
 *   추가하기 writes one at once); with rules, 내 자동화 (status dot, name, when it runs, the switch, ›), 전체 기록 보기,
 *   and the recommendations not taken yet. 새 자동화 and 말로 만들기 open the AI chat column.
 * - a rule's own page (› on its row), under the breadcrumb 자동화 › name: the name, which a click renames in place,
 *   the card to change and save it, and its 실행 기록 read from the rule's run log.
 * - 전체 기록, under the breadcrumb 자동화 › 전체 기록: every rule's runs, newest first, by day.
 * It only draws and reports: the rules come from the shared store, and delete asks before it removes anything.
 */

import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AutomationDraft, AutomationEventType, AutomationRule, AutomationRun, AutomationsSnapshot } from "../../../shared/automation-contract";
import type { FsLocation } from "../../../shared/fs-contract";
import type { LocaleKey } from "../../../shared/i18n/core";
import { cn } from "../lib/cn";
import { customRuleName, derivedTitle, failReason, folderLabel, kindsText, relativeTime, ruleTitle, runTone, whatText, whenText, type RunTone } from "../state/automations";
import { SparklesIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, FilePenIcon, FolderGlyph, PencilIcon, TabPlusIcon } from "./icons";
import { AgentSegment } from "./AgentSegment";
import { startErrorFix } from "../hooks/useErrorFix";
import { ErrorDetails } from "./ErrorDetails";
import { NoticeCard } from "./primitives/NoticeCard";
import { StatusDot } from "./primitives/StatusDot";
import { Switch } from "./primitives/Switch";

export interface AutomationsViewProps {
	readonly state: AutomationsSnapshot;
	readonly daemonBusy: boolean;
	readonly selectedId: string | null;
	readonly onSelect: (id: string) => void;
	/** Double click or Enter: open an AI Search draft to edit the rule. */
	readonly onEdit: (id: string) => void;
	readonly onAdd: () => void;
	/** 만들기: write the rule; resolves true once it is in the rules file. */
	readonly onCreate: (draft: AutomationDraft) => Promise<boolean>;
	/** The names people gave their rules; the list redraws when one changes. */
	readonly names?: Readonly<Record<string, string>>;
	/** ⋯ → 이름 바꾸기: store a rule's name; an empty one goes back to the derived title. */
	readonly onRename?: ((id: string, name: string) => Promise<void>) | undefined;
	/** The rule 수정 put in the card, or null while the card makes a new one. */
	readonly editing?: AutomationRule | null;
	/** 수정하기: rewrite the rule; resolves true once the rules file has it. */
	readonly onUpdate?: ((id: string, draft: AutomationDraft) => Promise<boolean>) | undefined;
	/** 취소 while editing: the card goes back to making a new rule. */
	readonly onCancelEdit?: (() => void) | undefined;
	/** The rule the 새 자동화 card would write, once the person has touched it; null when the card is untouched. */
	readonly onDraftChange?: ((draft: AutomationRule | null) => void) | undefined;
	readonly onPreview: (id: string) => void;
	readonly onAskDelete: (id: string) => void;
	readonly onSetDaemon: (enabled: boolean) => void;
	/** Read the rules and the service again after a failed read. */
	readonly onRetryStatus?: (() => void) | undefined;
	/** Right click on a row (`id`) or on the empty space (`null`), at the pointer. */
	readonly onContextMenu: (id: string | null, at: { readonly x: number; readonly y: number }) => void;
	readonly onOpenFolder: (path: string) => void;
	/** The 채팅 half of the AI 에이전트 tab's segment. */
	readonly onShowChat?: (() => void) | undefined;
	/** 새 자동화 and 말로 만들기: open the AI chat column to make a rule in words. */
	readonly onTalk?: (() => void) | undefined;
}

const TONE_DOT: Readonly<Record<RunTone, string>> = {
	ok: "--ok-dot",
	fail: "--error-orange-dot",
	never: "--text-faint",
};

/** The status dot: green after a clean run, orange after a failure, a filled grey one before any run. */
export function RunDot({ tone }: { readonly tone: RunTone }): ReactElement {
	return (
		<span data-run-tone={tone} className="flex flex-none">
			<StatusDot token={TONE_DOT[tone]} />
		</span>
	);
}

/* ------------------------------------------------------------ the new rule -- */

type KindId = "all" | "pdf" | "image" | "document";
type EventId = "create" | "update" | "createUpdate" | "delete";
type ModeId = "read" | "write";

const KIND_GLOBS: Readonly<Record<KindId, readonly string[]>> = {
	all: [],
	pdf: ["**/*.pdf"],
	image: ["png", "jpg", "jpeg", "heic", "gif", "webp"].map((ext) => `**/*.${ext}`),
	document: ["pdf", "doc", "docx", "hwp", "hwpx", "txt", "md", "ppt", "pptx", "xls", "xlsx"].map((ext) => `**/*.${ext}`),
};
const EVENTS: Readonly<Record<EventId, readonly AutomationEventType[]>> = {
	create: ["create"],
	update: ["update"],
	createUpdate: ["create", "update"],
	delete: ["delete"],
};
const PROFILES: Readonly<Record<ModeId, string>> = { read: "file-triage", write: "file-organizer" };
/** The folders a rule usually watches, in the order the chip offers them. */
const FOLDER_ICONS = ["downloads", "desktop", "documents", "pictures"] as const;

interface Template {
	readonly id: "screenshot" | "pdf" | "refresh";
	readonly folder: (typeof FOLDER_ICONS)[number];
	readonly kind: KindId;
	readonly event: EventId;
	readonly mode: ModeId;
	/** A template that runs a program instead of an agent; typing over its instruction makes it an agent rule. */
	readonly run?: readonly string[];
}

const TEMPLATES: readonly Template[] = [
	{ id: "screenshot", folder: "desktop", kind: "image", event: "create", mode: "write" },
	{ id: "pdf", folder: "downloads", kind: "pdf", event: "create", mode: "write" },
	{ id: "refresh", folder: "documents", kind: "all", event: "createUpdate", mode: "read", run: ["autorag", "refresh"] },
];

interface ChipOption<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly icon?: ReactNode;
}

/** A word in the 언제 sentence: a small white chip that opens its choices below it. */
function ChipSelect<T extends string>({
	value,
	options,
	label,
	icon,
	round = false,
	disabled = false,
	testId,
	onChange,
}: {
	readonly value: T | null;
	readonly options: readonly ChipOption<T>[];
	readonly label: string;
	readonly icon?: ReactNode;
	readonly round?: boolean;
	/** Read, not edited: one tone lighter, and it opens nothing. */
	readonly disabled?: boolean;
	readonly testId: string;
	readonly onChange: (value: T) => void;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent): void => {
			if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);
	const current = options.find((option) => option.value === value);
	return (
		<span ref={ref} className="relative inline-flex">
			<button
				type="button"
				data-testid={testId}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={label}
				disabled={disabled}
				className={cn(
					"inline-flex items-center gap-4 px-8 py-4 border-[0.5px] border-divider bg-window text-meta leading-[18px] whitespace-nowrap",
					disabled ? "text-ink cursor-default" : "text-ink cursor-pointer hover:border-border",
					round ? "rounded-[13px]" : "rounded-[7px]",
				)}
				onClick={() => setOpen((was) => !was)}
			>
				{current?.icon ?? icon}
				<span>{current?.label ?? label}</span>
				<ChevronDownIcon size={12} className="text-ink-muted" />
			</button>
			{open ? (
				<ul role="listbox" aria-label={label} className="absolute left-0 top-[calc(100%+4px)] z-30 m-0 w-max min-w-full list-none rounded-8 border border-border bg-window p-4 shadow-menu">
					{options.map((option) => (
						<li key={option.value}>
							<button
								type="button"
								role="option"
								aria-selected={option.value === value}
								data-testid={`${testId}-${option.value}`}
								className="flex w-full items-center gap-6 rounded-6 border-0 bg-transparent px-8 py-5 text-left text-meta text-ink whitespace-nowrap cursor-pointer hover:bg-hover"
								onClick={() => {
									onChange(option.value);
									setOpen(false);
								}}
							>
								{option.icon}
								<span className="flex-1 whitespace-nowrap">{option.label}</span>
								{option.value === value ? <CheckIcon size={12} className="text-accent-text" /> : <span className="w-12" />}
							</button>
						</li>
					))}
				</ul>
			) : null}
		</span>
	);
}

/** A standard folder the OS reports, by its sidebar glyph. */
function standardFolders(locations: readonly FsLocation[]): readonly ChipOption<string>[] {
	return FOLDER_ICONS.flatMap((kind) => {
		const place = locations.find((location) => location.icon === kind && location.available);
		return place === undefined ? [] : [{ value: place.path, label: folderLabel(place.path), icon: <FolderGlyph size={13} /> }];
	});
}

/** The card's choices as the rule they would make, so the inspector can say it in the rules' own sentence. */
function draftRule(draft: AutomationDraft): AutomationRule {
	return {
		id: "draft",
		paths: draft.paths,
		events: draft.events,
		include: draft.include,
		exclude: [],
		run: draft.run ?? [],
		...(draft.agent === undefined ? {} : { agent: draft.agent }),
		appendFiles: true,
		debounceMs: 0,
		timeoutMs: 0,
		lastRun: null,
	};
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** The chip a rule's files or changes fit, or null when they are a set the card does not offer (kept as written). */
function kindOf(include: readonly string[]): KindId | null {
	return (Object.keys(KIND_GLOBS) as KindId[]).find((kind) => sameList(KIND_GLOBS[kind], include)) ?? null;
}
function eventOf(events: readonly AutomationEventType[]): EventId | null {
	return (Object.keys(EVENTS) as EventId[]).find((event) => sameList(EVENTS[event], events)) ?? null;
}

function NewAutomationCard({
	onCreate,
	onUpdate,
	onCancelEdit,
	onDraftChange,
	pageMode = false,
	onClose,
	closable = true,
	editing,
	filled,
}: {
	readonly onCreate: AutomationsViewProps["onCreate"];
	readonly onUpdate: AutomationsViewProps["onUpdate"];
	readonly onCancelEdit: AutomationsViewProps["onCancelEdit"];
	readonly onDraftChange: AutomationsViewProps["onDraftChange"];
	/** On a rule's own page: the fields can be changed at once, 취소 shows beside 저장 once something differs, and 저장 waits for it. */
	readonly pageMode?: boolean;
	/** On the list's 새 자동화 card: 취소, beside 저장, closes the card. Absent while there is no rule to go back to. */
	readonly onClose?: (() => void) | undefined;
	/** 취소 shows on the empty card too (there are rules, so the card can go); otherwise only once it holds something. */
	readonly closable?: boolean;
	readonly editing: AutomationRule | null;
	readonly filled: { readonly template: Template; readonly at: number } | null;
}): ReactElement {
	const { t } = useTranslation();
	const [locations, setLocations] = useState<readonly FsLocation[]>([]);
	const [folder, setFolder] = useState<string | null>(null);
	const [kind, setKind] = useState<KindId>("pdf");
	const [event, setEvent] = useState<EventId>("create");
	const [task, setTask] = useState("");
	const [mode, setMode] = useState<ModeId>("read");
	const [run, setRun] = useState<readonly string[] | null>(null);
	// What a rule being edited has that the chips cannot say; kept as written until its chip is changed.
	const [customInclude, setCustomInclude] = useState<readonly string[] | null>(null);
	const [customEvents, setCustomEvents] = useState<readonly AutomationEventType[] | null>(null);
	const [customProfile, setCustomProfile] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// On a rule's own page the fields can be changed at once (the name is renamed from the title, not here);
	// 취소 shows once something differs from the saved rule.
	const [changed, setChanged] = useState(false);
	// The inspector speaks about the card only once the person has started on it.
	const [touched, setTouched] = useState(false);
	const cardRef = useRef<HTMLDivElement>(null);
	const taskRef = useRef<HTMLTextAreaElement>(null);
	// A 추천 자동화 row can open the card before the OS has said where its folders are: its folder waits for them.
	const pendingFolder = useRef<(typeof FOLDER_ICONS)[number] | null>(null);

	useEffect(() => {
		let live = true;
		const fs = window.autorag?.fs;
		void fs
			?.locations()
			.then((loaded) => {
				if (!live) return;
				setLocations(loaded);
				const waiting = pendingFolder.current;
				pendingFolder.current = null;
				if (waiting !== null) setFolder(loaded.find((location) => location.icon === waiting && location.available)?.path ?? null);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, []);
	const standard = standardFolders(locations);
	const pathOf = (kindOfFolder: (typeof FOLDER_ICONS)[number]): string | null => locations.find((location) => location.icon === kindOfFolder && location.available)?.path ?? null;
	// 다운로드 until the person picks another; a folder the OS does not have is never offered.
	const chosenFolder = folder ?? standard[0]?.value ?? null;
	// A rule being edited may watch a folder that is not one of the standard ones: it is offered too.
	const folders = chosenFolder === null || standard.some((option) => option.value === chosenFolder) ? standard : [...standard, { value: chosenFolder, label: folderLabel(chosenFolder), icon: <FolderGlyph size={13} /> }];

	const reset = (): void => {
		setTask("");
		setRun(null);
		setCustomInclude(null);
		setCustomEvents(null);
		setCustomProfile(null);
		setTouched(false);
	};

	// A 추천 자동화 row fills the card, once per click.
	useEffect(() => {
		if (filled === null) return;
		const { template } = filled;
		const path = pathOf(template.folder);
		pendingFolder.current = path === null && locations.length === 0 ? template.folder : null;
		setFolder(path);
		setKind(template.kind);
		setEvent(template.event);
		setMode(template.mode);
		setTask(t(`automations.templates.${template.id}.task`));
		setRun(template.run ?? null);
		setCustomInclude(null);
		setCustomEvents(null);
		setCustomProfile(null);
		setTouched(true);
		taskRef.current?.focus();
		// The locations are read once; the template is what changes.
	}, [filled]);

	const load = (rule: AutomationRule): void => {
		const matchedKind = kindOf(rule.include);
		const matchedEvent = eventOf(rule.events);
		const profile = rule.agent?.profile ?? null;
		setFolder(rule.paths[0] ?? null);
		setKind(matchedKind ?? "all");
		setCustomInclude(matchedKind === null ? rule.include : null);
		setEvent(matchedEvent ?? "create");
		setCustomEvents(matchedEvent === null ? rule.events : null);
		setMode(profile === PROFILES.write ? "write" : "read");
		setCustomProfile(profile !== null && profile !== PROFILES.read && profile !== PROFILES.write ? profile : null);
		setTask(rule.agent?.task ?? whatText(rule, { full: true }));
		setRun(rule.agent === undefined ? rule.run : null);
		setTouched(true);
		setChanged(false);
	};

	// 수정 on a rule: the card takes the rule in, and 만들기 becomes 수정하기. Leaving a rule empties the card; a card
	// that opens with no rule keeps what a 추천 자동화 row just put in it.
	const editedBefore = useRef<string | null>(null);
	useEffect(() => {
		const before = editedBefore.current;
		editedBefore.current = editing?.id ?? null;
		setChanged(false);
		if (editing === null) {
			if (before !== null) reset();
			return;
		}
		load(editing);
		// On a rule's own page the card is read first; only the list's card jumps to the instruction.
		if (!pageMode) {
			cardRef.current?.scrollIntoView?.({ block: "nearest" });
			taskRef.current?.focus();
		}
	}, [editing?.id]);

	const draft: AutomationDraft | null =
		chosenFolder === null
			? null
			: {
					paths: editing !== null && editing.paths.length > 1 && editing.paths[0] === chosenFolder ? editing.paths : [chosenFolder],
					events: customEvents ?? EVENTS[event],
					include: customInclude ?? KIND_GLOBS[kind],
					...(run === null ? { agent: { profile: customProfile ?? PROFILES[mode], task: task.trim() } } : { run }),
				};
	// The work shows in the toast, so the button keeps its look while it runs; `busy` only stops a second click.
	const canSubmit = draft !== null && task.trim().length > 0;

	useEffect(() => {
		onDraftChange?.(touched && draft !== null ? draftRule(draft) : null);
	}, [touched, JSON.stringify(draft)]);
	useEffect(() => () => onDraftChange?.(null), []);
	const touch = <T,>(set: (value: T) => void, clear?: () => void) => (value: T): void => {
		set(value);
		clear?.();
		setTouched(true);
		setChanged(true);
	};
	const submit = async (): Promise<void> => {
		if (!canSubmit || draft === null || busy) return;
		setBusy(true);
		const ok = editing === null ? await onCreate(draft) : onUpdate === undefined ? false : await onUpdate(editing.id, draft);
		setBusy(false);
		if (ok && editing === null) reset();
		if (ok && pageMode) setChanged(false);
	};

	const kinds: readonly ChipOption<KindId>[] = (["all", "pdf", "image", "document"] as const).map((value) => ({ value, label: t(`automations.create.kind.${value}`) }));
	const events: readonly ChipOption<EventId>[] = (["create", "update", "createUpdate", "delete"] as const).map((value) => ({ value, label: t(`automations.create.event.${value}`) }));
	const modes: readonly ChipOption<ModeId>[] = [
		{ value: "read", label: t("automations.create.mode.read"), icon: <EyeIcon size={13} /> },
		{ value: "write", label: t("automations.create.mode.write"), icon: <FilePenIcon /> },
	];
	const chips: Readonly<Record<string, ReactNode>> = {
		folder: (
			<ChipSelect
				value={chosenFolder}
				options={folders}
				label={chosenFolder === null ? t("automations.create.pickFolder") : folderLabel(chosenFolder)}
				icon={<FolderGlyph size={13} />}
				testId="automation-new-folder"
				onChange={touch(setFolder)}
			/>
		),
		kind: (
			<ChipSelect
				value={customInclude === null ? kind : null}
				options={kinds}
				label={customInclude === null ? t("automations.create.kindLabel") : t("automations.kinds.noun", { kinds: kindsText(customInclude) })}
				testId="automation-new-kind"
				onChange={touch(setKind, () => setCustomInclude(null))}
			/>
		),
		event: (
			<ChipSelect
				value={customEvents === null ? event : null}
				options={events}
				label={customEvents === null ? t("automations.create.eventLabel") : t("automations.create.event.other")}
				testId="automation-new-event"
				onChange={touch(setEvent, () => setCustomEvents(null))}
			/>
		),
	};
	// The sentence's word order is the language's: the chips sit where its {{folder}}, {{kind}} and {{event}} are.
	const sentence = t("automations.create.sentence", { folder: "\u0000folder\u0000", kind: "\u0000kind\u0000", event: "\u0000event\u0000" }).split("\u0000");

	return (
		<div ref={cardRef} className={cn("flex flex-col gap-8 rounded-[14px] bg-window p-14", pageMode && "border border-border")} data-testid="automation-new" data-editing={editing?.id}>
			<span className="text-meta font-medium leading-[16px] text-ink-muted">{t("automations.create.when")}</span>
			<div className="flex flex-wrap items-center gap-8 py-4" data-testid="automation-new-when">
				{sentence.map((part, index) =>
					part in chips ? (
						<Fragment key={index}>{chips[part]}</Fragment>
					) : part.trim().length === 0 ? null : (
						<span key={index} className="text-meta leading-[18px] text-ink-muted">{part.trim()}</span>
					),
				)}
			</div>
			<span className="mt-4 text-meta font-medium leading-[16px] text-ink-muted">{t("automations.create.task")}</span>
			<textarea
				ref={taskRef}
				data-testid="automation-new-task"
				value={task}
				placeholder={t("automations.create.taskPlaceholder")}
				aria-label={t("automations.create.task")}
				className={cn(
					"h-60 resize-none rounded-10 border-[0.5px] border-divider bg-window px-10 py-8 text-[13px] leading-[20px] outline-none placeholder:text-ink-faint",
					"text-ink focus:border-accent",
				)}
				onChange={(change) => {
					setTask(change.target.value);
					setTouched(true);
					setChanged(true);
					// Typing over a program's words makes it an instruction for the agent.
					setRun(null);
				}}
			/>
			<div className="flex items-center gap-6">
				{/* Shown on every card, a program rule (검색 바로 최신화) included, so the card keeps one shape. */}
				<ChipSelect value={mode} options={modes} label={t("automations.create.modeLabel")} round testId="automation-new-mode" onChange={touch(setMode, () => setCustomProfile(null))} />
				<span className="flex-1" />
				{/* 취소 is a quiet word beside 저장 (Figma 641:13493, 641:13600): it closes the new-automation card, or undoes a change on a rule's page. */}
				{(editing === null ? onClose !== undefined && (closable || touched) : !pageMode || changed) ? (
					<button
						type="button"
						data-action="automation-cancel-edit"
						className="mr-6 inline-flex h-32 items-center border-0 bg-transparent p-0 text-meta text-ink-muted cursor-pointer hover:text-ink"
						onClick={() => {
							if (editing === null) {
								reset();
								onClose?.();
								return;
							}
							if (!pageMode) {
								onCancelEdit?.();
								return;
							}
							load(editing);
						}}
					>
						{t("common.cancel")}
					</button>
				) : null}
				<button
					type="button"
					data-action={editing === null ? "automation-create" : "automation-update"}
					disabled={!canSubmit || (pageMode && !changed)}
					className="inline-flex h-32 items-center justify-center rounded-6 border-0 bg-accent px-12 text-meta font-medium text-on-accent cursor-pointer disabled:cursor-default disabled:opacity-50"
					onClick={() => void submit()}
				>
					{editing === null ? t("automations.create.submit") : pageMode ? t("common.save") : t("automations.create.submitEdit")}
				</button>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ the list -- */

/** A 내 자동화 row (Figma 641:13493): the name over when it runs, the on/off switch, and ›, which opens the rule's page. */
function RuleRow({
	rule,
	selected,
	onSelect,
	onOpen,
	onContextMenu,
}: {
	readonly rule: AutomationRule;
	readonly selected: boolean;
	readonly onSelect: (id: string) => void;
	readonly onOpen: (id: string) => void;
	readonly onContextMenu: AutomationsViewProps["onContextMenu"];
}): ReactElement {
	const { t } = useTranslation();
	const ref = useRef<HTMLDivElement>(null);
	// The arrow keys move the selection in the parent; the row follows it into view.
	useEffect(() => {
		if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
	}, [selected]);
	return (
		<div
			ref={ref}
			role="row"
			aria-selected={selected}
			data-rule-id={rule.id}
			// Opening a rule selects it, and the selection outlives the trip back to
			// the list, so it draws no fill: the row looks as it did before it was opened.
			className="flex items-center gap-10 px-12 py-10 select-none cursor-pointer bg-window hover:bg-hover-row"
			onClick={() => {
				onSelect(rule.id);
				onOpen(rule.id);
			}}
			onContextMenu={(event: ReactMouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				onContextMenu(rule.id, { x: event.clientX, y: event.clientY });
			}}
		>
			<div role="gridcell" className="flex min-w-0 flex-1 flex-col gap-2">
				<span className="truncate text-[13px] font-medium leading-[21px] text-ink">{ruleTitle(rule)}</span>
				<span className="truncate text-badge leading-[16px] text-ink-muted">{whenText(rule)}</span>
			</div>
			{/* Figma 641:13493: the on/off switch is drawn, not wired yet (the librarian's rule format has no such field). */}
			<span role="presentation" className="flex flex-none items-center" onClick={(event) => event.stopPropagation()}>
				<Switch checked onChange={() => undefined} ariaLabel={t("automations.detail.runOn")} dataSwitchId="automation-rule-on" />
			</span>
			<ChevronRightIcon size={16} className="flex-none text-ink-faint" />
		</div>
	);
}

function Section({ title, aside, muted = false, children }: { readonly title: string; readonly aside?: string; readonly muted?: boolean; readonly children: ReactNode }): ReactElement {
	return (
		<section className="flex flex-col gap-8">
			<div className="flex items-center gap-8">
				{/* The list's sections read in the body grey (Figma 641:13493), a rule page's 설정 and 실행 기록 in the muted one at 18px (641:13747). */}
				<h2 className={cn("m-0 text-meta font-medium", muted ? "leading-[18px] text-ink-muted" : "leading-[16px] text-ink-body")}>{title}</h2>
				{aside === undefined ? null : (
					<>
						<span className="flex-1" />
						<span className="text-badge leading-[16px] text-ink-muted">{aside}</span>
					</>
				)}
			</div>
			{children}
		</section>
	);
}

/** A rule's runs from its log, newest first, read again whenever any rule's last run changes. */
function useRunHistory(ids: readonly string[], changed: string): Readonly<Record<string, readonly AutomationRun[]>> {
	const [history, setHistory] = useState<Readonly<Record<string, readonly AutomationRun[]>>>({});
	const key = ids.join("\n");
	useEffect(() => {
		let live = true;
		const bridge = window.autorag?.automations;
		if (bridge === undefined || typeof bridge.history !== "function") return;
		void Promise.all(ids.map(async (id) => [id, await bridge.history(id).catch(() => [] as readonly AutomationRun[])] as const)).then((entries) => {
			if (live) setHistory(Object.fromEntries(entries));
		});
		return () => {
			live = false;
		};
	}, [key, changed]);
	return history;
}

/** What one run did: how many files it took and how it ended, e.g. "파일 2개 · 시간 초과". */
function runOutcome(run: AutomationRun, t: TFunction): string {
	const result = runTone(run) === "ok" ? t("automations.inspector.runDone") : failReason(run);
	const files = run.eventCount > 0 ? t("automations.inspector.runFiles", { count: run.eventCount }) : null;
	return [files, result].filter((part): part is string => part !== null && part.length > 0).join(" · ");
}

/**
 * One line of 실행 기록 (Figma 621:4882): the dot, how many files it took over how it ended (the rule's name over its
 * outcome in 전체 기록), when, and the error a failed run left. The run log counts the files but does not name them.
 */
function RunLine({ run, rule, onOpen, flat = false }: { readonly run: AutomationRun; readonly rule?: AutomationRule; readonly onOpen?: () => void; readonly flat?: boolean }): ReactElement {
	const { t } = useTranslation();
	const tone = runTone(run);
	const result = tone === "ok" ? t("automations.inspector.runDone") : failReason(run);
	const files = run.eventCount > 0 ? t("automations.inspector.runFiles", { count: run.eventCount }) : null;
	const first = rule !== undefined ? ruleTitle(rule) : (files ?? result);
	const second = rule !== undefined ? runOutcome(run, t) : files === null ? null : result;
	const body = (
		<>
			<div className="flex w-full items-center gap-10">
				<RunDot tone={tone} />
				<div className="flex min-w-0 flex-1 flex-col gap-px">
					<span className="truncate text-[13px] leading-[20px] text-ink">{first}</span>
					{second === null ? null : <span className="truncate text-badge leading-[17px] text-ink-muted">{second}</span>}
				</div>
				<span className="flex-none text-meta leading-[18px] text-ink-muted">{relativeTime(run.startedAt)}</span>
				{onOpen === undefined ? null : <ChevronRightIcon size={14} className="flex-none text-ink-faint" />}
			</div>
			{tone === "fail" && run.error !== undefined && rule === undefined ? (
				<p className="m-0 w-full rounded-8 bg-subtle-alt px-10 py-7 text-meta leading-[18px] text-ink-body [overflow-wrap:anywhere]">{run.error}</p>
			) : null}
		</>
	);
	// On a rule's own page the runs are plain lines between hairlines (Figma 641:13600); in 전체 기록 they sit in the rounded list.
	const row = cn("flex w-full flex-col items-start gap-6 border-0 py-10 text-left", flat ? "bg-transparent px-4" : "bg-window px-14");
	return onOpen === undefined ? (
		<div className={row} data-run={run.startedAt}>
			{body}
		</div>
	) : (
		<button type="button" className={cn(row, "cursor-pointer hover:bg-hover-row")} data-run={run.startedAt} onClick={onOpen}>
			{body}
		</button>
	);
}

/**
 * The rule's name on its own page. It reads as editable before anyone hovers: the pencil sits beside it, and the
 * name takes a soft background under the pointer. A click turns it into a field; Enter or leaving it saves, Esc
 * keeps the old name, and an empty name goes back to the one derived from the rule.
 */
function EditableTitle({ rule, onRename }: { readonly rule: AutomationRule; readonly onRename: AutomationsViewProps["onRename"] }): ReactElement {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");
	const start = (): void => {
		setName(customRuleName(rule) ?? ruleTitle(rule));
		setEditing(true);
	};
	const finish = (save: boolean): void => {
		setEditing(false);
		const next = name.trim() === derivedTitle(rule) ? "" : name.trim();
		if (save && next !== (customRuleName(rule) ?? "")) void onRename?.(rule.id, next);
	};
	if (editing) {
		return (
			<input
				autoFocus
				data-testid="automation-title-input"
				value={name}
				placeholder={derivedTitle(rule)}
				aria-label={t("automations.row.rename")}
				className="h-28 min-w-0 flex-1 rounded-6 border border-accent bg-window px-6 text-[17px] font-medium leading-[22px] text-ink outline-none placeholder:font-normal placeholder:text-ink-faint"
				onFocus={(event) => event.currentTarget.select()}
				onChange={(event) => setName(event.target.value)}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (event.key === "Enter") finish(true);
					if (event.key === "Escape") finish(false);
				}}
				onBlur={() => finish(true)}
			/>
		);
	}
	return (
		<button
			type="button"
			data-action="automation-rename"
			title={t("automations.row.rename")}
			aria-label={`${ruleTitle(rule)} — ${t("automations.row.rename")}`}
			className="group inline-flex h-28 min-w-0 items-center gap-6 rounded-6 border-0 bg-transparent px-6 -mx-6 text-left cursor-text hover:bg-hover"
			onClick={start}
		>
			<span className="truncate text-[17px] font-medium leading-[22px] text-ink">{ruleTitle(rule)}</span>
			<PencilIcon size={14} className="flex-none text-ink-faint group-hover:text-ink-muted" />
		</button>
	);
}

/** A rule's own page (Figma 621:4882): back to the list, the name, the card to change it, and its 실행 기록. */
function AutomationDetail({
	rule,
	runs,
	onBack,
	onRename,
	onUpdate,
	onDelete,
	onDraftChange,
}: {
	readonly rule: AutomationRule;
	readonly runs: readonly AutomationRun[] | undefined;
	readonly onBack: () => void;
	readonly onRename: AutomationsViewProps["onRename"];
	readonly onUpdate: AutomationsViewProps["onUpdate"];
	readonly onDelete: () => void;
	readonly onDraftChange: AutomationsViewProps["onDraftChange"];
}): ReactElement {
	const { t } = useTranslation();
	// The log is the record; until it has been read (or if it is gone) the rule's last run still shows.
	const list = runs !== undefined && runs.length > 0 ? runs : rule.lastRun === null ? [] : [rule.lastRun];
	return (
		<div className="flex flex-col gap-24" data-automation-detail={rule.id}>
			<div className="flex flex-col gap-6">
				<Breadcrumb current={ruleTitle(rule)} onRoot={onBack} />
				<div className="flex min-w-0 items-center gap-8">
					<EditableTitle key={rule.id} rule={rule} onRename={onRename} />
					<span className="flex-1" />
					{/* Figma 641:13600: drawn, not wired yet (the librarian's rule format has no on/off field). */}
					<span className="flex-none text-badge leading-[16px] text-ink-muted">{t("automations.detail.runOn")}</span>
					<Switch checked onChange={() => undefined} ariaLabel={t("automations.detail.runOn")} dataSwitchId="automation-detail-on" />
				</div>
			</div>
			<Section muted title={t("automations.detail.settings")}>
				<NewAutomationCard onCreate={async () => false} onUpdate={onUpdate} onCancelEdit={undefined} onDraftChange={onDraftChange} pageMode editing={rule} filled={null} />
			</Section>
			<Section muted title={list.length === 0 ? t("automations.detail.history") : `${t("automations.detail.history")} (${list.length})`}>
				{list.length === 0 ? (
					// Figma 641:13747: no box; the faint line sits between the same hairlines the runs would, 20px from each.
					<p className="m-0 border-t-[0.5px] border-divider py-20 text-meta leading-[16px] text-ink-faint" data-runs-empty>{t("automations.inspector.noRuns")}</p>
				) : (
					<div role="list" aria-label={t("automations.detail.history")} className="flex flex-col border-y-[0.5px] border-divider [&>*+*]:border-t-[0.5px] [&>*+*]:border-divider">
						{list.map((run) => (
							<RunLine key={`${run.startedAt}-${run.durationMs}`} run={run} flat />
						))}
					</div>
				)}
			</Section>
			{/* The way out of a rule sits bottom right, away from 저장 (Figma 641:13600). */}
			<div className="flex justify-end">
				<button type="button" data-action="automation-delete" className="border-0 bg-transparent p-0 text-meta font-medium text-danger-text cursor-pointer hover:opacity-80" onClick={onDelete}>
					{t("automations.detail.delete")}
				</button>
			</div>
		</div>
	);
}

/** Where the page is under 자동화 (Figma 676:646, 676:790): 자동화 goes back to the list, the last word is this page. */
function Breadcrumb({ current, onRoot }: { readonly current: string; readonly onRoot: () => void }): ReactElement {
	const { t } = useTranslation();
	return (
		<nav aria-label={t("automations.breadcrumb")} className="flex min-w-0 items-center gap-6 text-[13px] leading-[18px]" data-automation-breadcrumb>
			<button type="button" data-action="automation-back" className="flex-none border-0 bg-transparent p-0 text-ink-muted cursor-pointer hover:text-ink" onClick={onRoot}>
				{t("places.automations")}
			</button>
			<ChevronRightIcon size={12} className="flex-none text-ink-faint" />
			<span aria-current="page" className="min-w-0 truncate font-medium text-ink">
				{current}
			</span>
		</nav>
	);
}

/** The day a run falls on, as the 전체 기록 heading says it: 오늘, 어제, or the date. */
function dayLabel(at: number, t: TFunction, language: string, now: number = Date.now()): string {
	const start = (time: number): number => new Date(time).setHours(0, 0, 0, 0);
	const days = Math.round((start(now) - start(at)) / 86_400_000);
	if (days === 0) return t("automations.all.today");
	if (days === 1) return t("automations.all.yesterday");
	return new Intl.DateTimeFormat(language, { month: "long", day: "numeric" }).format(at);
}

/** 전체 기록 (Figma 676:646): every rule's runs, newest first, under the day they ran; a row opens its rule. */
function AllRunsPage({ rules, history, onOpen, onBack }: { readonly rules: readonly AutomationRule[]; readonly history: Readonly<Record<string, readonly AutomationRun[]>>; readonly onOpen: (id: string) => void; readonly onBack: () => void }): ReactElement {
	const { t, i18n } = useTranslation();
	const all = rules
		.flatMap((rule) => (history[rule.id] ?? (rule.lastRun === null ? [] : [rule.lastRun])).map((run) => ({ rule, run })))
		.sort((a, b) => b.run.startedAt - a.run.startedAt);
	const days: { label: string; runs: typeof all }[] = [];
	for (const item of all) {
		const label = dayLabel(item.run.startedAt, t, i18n.language);
		const last = days[days.length - 1];
		if (last !== undefined && last.label === label) last.runs.push(item);
		else days.push({ label, runs: [item] });
	}
	return (
		<section className="flex flex-col gap-6" data-automation-all-runs>
			<Breadcrumb current={t("automations.all.title")} onRoot={onBack} />
			<h1 className="m-0 text-[20px] font-medium leading-[28px] text-ink">{t("automations.all.title")}</h1>
			{all.length === 0 ? (
				<p className="m-0 mt-18 border-t-[0.5px] border-divider py-20 text-meta leading-[16px] text-ink-faint" data-runs-empty>{t("automations.inspector.noRuns")}</p>
			) : (
				<div className="mt-10 flex flex-col gap-18">
					{days.map((day) => (
						<div key={day.label} className="flex flex-col">
							<h2 className="m-0 border-b-[0.5px] border-divider pb-6 text-meta font-medium leading-[16px] text-ink-muted">{day.label}</h2>
							<div role="list" aria-label={day.label} className="flex flex-col">
								{day.runs.map(({ rule, run }) => (
									<RunLine key={`${rule.id}-${run.startedAt}`} run={run} rule={rule} onOpen={() => onOpen(rule.id)} flat />
								))}
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

/* ------------------------------------------------------------ recommendations -- */

/** The folders the OS reports, read once. */
function useLocations(): readonly FsLocation[] {
	const [locations, setLocations] = useState<readonly FsLocation[]>([]);
	useEffect(() => {
		let live = true;
		void window.autorag?.fs
			?.locations()
			.then((loaded) => {
				if (live) setLocations(loaded);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, []);
	return locations;
}

export type TemplateId = Template["id"];

function templateOf(id: TemplateId): Template {
	return TEMPLATES.find((template) => template.id === id) ?? TEMPLATES[0]!;
}

/** A recommendation as the rule it would write; null until the OS has said where its folder is. */
function templateDraft(template: Template, locations: readonly FsLocation[], task: string, folder?: string | null): AutomationDraft | null {
	const path = folder ?? locations.find((location) => location.icon === template.folder && location.available)?.path ?? null;
	if (path === null) return null;
	return {
		paths: [path],
		events: EVENTS[template.event],
		include: KIND_GLOBS[template.kind],
		...(template.run === undefined ? { agent: { profile: PROFILES[template.mode], task } } : { run: template.run }),
	};
}

/** A rule already does what the recommendation would: the same files, the same changes, and the same kind of work. */
export function templateTaken(rules: readonly AutomationRule[], id: TemplateId): boolean {
	const template = templateOf(id);
	return rules.some(
		(rule) =>
			sameList(rule.include, KIND_GLOBS[template.kind]) &&
			sameList(rule.events, EVENTS[template.event]) &&
			(template.run === undefined ? rule.agent !== undefined : rule.agent === undefined && rule.run.join(" ") === template.run.join(" ")),
	);
}

/**
 * One recommendation (Figma 672:3718): the chevron, its name over when it runs, and 추가하기. A click on the row opens
 * it downward to show what it would do, read-only (언제, 할 일); 추가하기 writes it at once, open or not.
 */
function RecommendationCard({ template, locations, onAdd }: { readonly template: Template; readonly locations: readonly FsLocation[]; readonly onAdd: (draft: AutomationDraft) => Promise<boolean> }): ReactElement {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const task = t(`automations.templates.${template.id}.task` as LocaleKey);
	const draft = templateDraft(template, locations, task);
	const when = draft === null ? t(`automations.templates.${template.id}.desc` as LocaleKey) : whenText(draftRule(draft));
	return (
		<div className="flex flex-col gap-10 rounded-12 border border-border bg-window px-16 py-12" data-template={template.id} data-open={open ? "true" : undefined}>
			<div className="flex items-center gap-10">
				<button
					type="button"
					aria-expanded={open}
					className="flex min-w-0 flex-1 items-center gap-10 border-0 bg-transparent p-0 text-left cursor-pointer"
					onClick={() => setOpen((was) => !was)}
				>
					<ChevronDownIcon size={13} className={cn("flex-none text-ink-muted transition-transform duration-(--dur-color)", open && "rotate-180")} />
					<span className="flex min-w-0 flex-1 flex-col gap-1">
						<span className="truncate text-[14px] font-medium leading-[20px] text-ink">{t(`automations.templates.${template.id}.title` as LocaleKey)}</span>
						<span className="truncate text-meta leading-[17px] text-ink-muted">{when}</span>
					</span>
				</button>
				<button
					type="button"
					data-action="automation-template-add"
					disabled={draft === null || busy}
					className={cn(
						"inline-flex h-28 flex-none items-center rounded-6 px-10 text-meta font-medium cursor-pointer disabled:cursor-default disabled:opacity-50",
						open ? "border-0 bg-accent text-on-accent hover:bg-accent-hover" : "border border-border bg-window text-ink hover:bg-hover",
					)}
					onClick={() => {
						if (draft === null) return;
						setBusy(true);
						void onAdd(draft).finally(() => setBusy(false));
					}}
				>
					{t("automations.recs.add")}
				</button>
			</div>
			{open ? (
				<dl className="m-0 grid grid-cols-[auto_1fr] gap-x-16 gap-y-4 rounded-8 bg-subtle-alt px-12 py-8 text-meta leading-[18px]">
					<dt className="text-ink-muted">{t("automations.create.when")}</dt>
					<dd className="m-0 text-ink">{when}</dd>
					<dt className="text-ink-muted">{t("automations.create.task")}</dt>
					<dd className="m-0 text-ink">{task}</dd>
				</dl>
			) : null}
		</div>
	);
}

/**
 * The card a chat suggestion opens into (Figma 672:3678; the narrow one in the 자동화 column, 672:3740): the rule the
 * conversation suggests, filled in, as the 언제 sentence of chips and the 할 일 line. Nothing is written until 추가하기.
 */
export function AutomationSuggestionCard({
	templateId,
	narrow = false,
	onCreate,
	onCancel,
}: {
	readonly templateId: TemplateId;
	readonly narrow?: boolean;
	readonly onCreate: (draft: AutomationDraft) => Promise<boolean>;
	readonly onCancel: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const template = templateOf(templateId);
	const locations = useLocations();
	const [folder, setFolder] = useState<string | null>(null);
	const [kind, setKind] = useState<KindId>(template.kind);
	const [event, setEvent] = useState<EventId>(template.event);
	const [task, setTask] = useState(() => t(`automations.templates.${template.id}.task` as LocaleKey));
	const [busy, setBusy] = useState(false);
	const standard = standardFolders(locations);
	const chosen = folder ?? locations.find((location) => location.icon === template.folder && location.available)?.path ?? standard[0]?.value ?? null;
	// A template that runs a program stays one only while nothing about it was changed; otherwise it is the agent's rule.
	const program = template.run !== undefined && kind === template.kind && event === template.event && task.trim() === t(`automations.templates.${template.id}.task` as LocaleKey) ? template.run : null;
	const draft: AutomationDraft | null =
		chosen === null
			? null
			: {
					paths: [chosen],
					events: EVENTS[event],
					include: KIND_GLOBS[kind],
					...(program === null ? { agent: { profile: PROFILES[template.mode], task: task.trim() } } : { run: program }),
				};
	const kinds: readonly ChipOption<KindId>[] = (["all", "pdf", "image", "document"] as const).map((value) => ({ value, label: t(`automations.create.kind.${value}`) }));
	const events: readonly ChipOption<EventId>[] = (["create", "update", "createUpdate", "delete"] as const).map((value) => ({ value, label: t(`automations.create.event.${value}`) }));
	const chips: Readonly<Record<string, ReactNode>> = {
		folder: <ChipSelect value={chosen} options={standard} label={chosen === null ? t("automations.create.pickFolder") : folderLabel(chosen)} icon={<FolderGlyph size={13} />} testId="automation-suggest-folder" onChange={setFolder} />,
		kind: <ChipSelect value={kind} options={kinds} label={t("automations.create.kindLabel")} testId="automation-suggest-kind" onChange={setKind} />,
		event: <ChipSelect value={event} options={events} label={t("automations.create.eventLabel")} testId="automation-suggest-event" onChange={setEvent} />,
	};
	const sentence = t("automations.create.sentence", { folder: "\u0000folder\u0000", kind: "\u0000kind\u0000", event: "\u0000event\u0000" }).split("\u0000");
	const canSubmit = draft !== null && task.trim().length > 0 && !busy;
	return (
		<div className={cn("flex flex-col rounded-12 border border-border bg-window", narrow ? "gap-6 p-10" : "gap-10 px-14 py-12")} data-automation-suggest={templateId}>
			{narrow ? <span className="text-badge leading-[15px] text-ink-muted">{t("automations.create.when")}</span> : null}
			<div className="flex flex-wrap items-center gap-6">
				{sentence.map((part, index) =>
					part in chips ? <Fragment key={index}>{chips[part]}</Fragment> : part.trim().length === 0 ? null : <span key={index} className="text-meta leading-[18px] text-ink-muted">{part.trim()}</span>,
				)}
			</div>
			{narrow ? <span className="text-badge leading-[15px] text-ink-muted">{t("automations.create.task")}</span> : null}
			<input
				value={task}
				aria-label={t("automations.create.task")}
				placeholder={t("automations.create.taskPlaceholder")}
				data-testid="automation-suggest-task"
				className={cn("h-28 rounded-6 border-[0.5px] border-divider bg-subtle-alt px-8 text-meta text-ink outline-none focus:border-accent", narrow ? "w-full" : "w-auto min-w-[160px] self-start field-sizing-content max-w-full")}
				onChange={(change) => setTask(change.target.value)}
			/>
			<div className="flex items-center justify-end gap-12">
				<button type="button" className="border-0 bg-transparent p-0 text-meta text-ink-muted cursor-pointer hover:text-ink" onClick={onCancel}>
					{t("common.cancel")}
				</button>
				<button
					type="button"
					data-action="automation-suggest-create"
					disabled={!canSubmit}
					className="inline-flex h-28 items-center rounded-6 border-0 bg-accent px-10 text-meta font-medium text-on-accent cursor-pointer hover:bg-accent-hover disabled:cursor-default disabled:opacity-50"
					onClick={() => {
						if (draft === null) return;
						setBusy(true);
						void onCreate(draft).finally(() => setBusy(false));
					}}
				>
					{t("automations.recs.add")}
				</button>
			</div>
		</div>
	);
}

export function AutomationsView({ state, selectedId, onSelect, onEdit, onAskDelete, onRename, onCreate, onUpdate, onCancelEdit, editing = null, onDraftChange, onContextMenu, onRetryStatus, onShowChat, onTalk }: AutomationsViewProps): ReactElement {
	const { t } = useTranslation();
	const [page, setPage] = useState<"list" | "all">("list");
	const locations = useLocations();
	const broken = state.configError !== null;
	const history = useRunHistory(
		[...new Set([...state.rules.map((rule) => rule.id), ...(editing === null ? [] : [editing.id])])],
		state.rules.map((rule) => rule.lastRun?.startedAt ?? 0).join(","),
	);
	// 수정, from anywhere (the list, a menu, the folder inspector, Quick Look), opens the rule's own page.
	const detail = editing;
	const open = (id: string): void => {
		setPage("list");
		onEdit(id);
	};
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		scrollRef.current?.scrollTo?.({ top: 0 });
	}, [detail?.id, page]);
	const recommendations = TEMPLATES.filter((template) => !templateTaken(state.rules, template.id));
	const recommendationCards = recommendations.map((template) => <RecommendationCard key={template.id} template={template} locations={locations} onAdd={onCreate} />);
	return (
		<section data-automations-view className="flex min-h-0 flex-1 flex-col bg-window" aria-label={t("automations.list")}>
			{/* The AI 에이전트 tab's head (Figma 672:3718): the mark and the name on the left, 채팅 | 자동화 in the middle. */}
			<div className="automations-head grid flex-none grid-cols-[1fr_auto_1fr] items-center gap-8 h-tab px-12 select-none" data-automations-head>
				<span className="flex min-w-0 items-center gap-8">
					<span className="grid flex-none place-items-center text-accent">
						<SparklesIcon />
					</span>
					<strong className="truncate text-sm font-medium leading-[19.5px] text-ink">{t("places.aiSearch")}</strong>
				</span>
				<AgentSegment value="automations" onChange={(value) => (value === "chat" ? onShowChat?.() : undefined)} />
				<span />
			</div>
			<div
				ref={scrollRef}
				data-rules-body
				className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
				onContextMenu={(event) => {
					event.preventDefault();
					onContextMenu(null, { x: event.clientX, y: event.clientY });
				}}
			>
				{/* Narrower than half the workspace with both sidebars open (--pane-min-width), the page is cut on the right instead of squeezed. */}
				<div className="min-w-(--pane-min-width) px-40 pb-40 pt-32">
				<div className="mx-auto flex w-full max-w-[640px] flex-col gap-24">
					{state.error === null ? null : (
						// Figma 644:253: the shared notice card; the raw reason stays behind 자세히 보기, and the way on is 다시 확인 or AI로 해결하기.
						<NoticeCard
							role="alert"
							tone="error"
							title={t("automations.errors.statusTitle")}
							footer={<ErrorDetails message={state.error} className="mt-0" quiet />}
							actions={[
								{ label: t("appError.fixAction"), primary: true, icon: <SparklesIcon />, onClick: () => startErrorFix(state.error ?? "", onRetryStatus, "automations") },
								...(onRetryStatus === undefined ? [] : [{ label: t("automations.errors.retry"), onClick: onRetryStatus }]),
							]}
						>
							{t("automations.errors.statusHint")}
						</NoticeCard>
					)}
					{broken ? (
						<div className="flex flex-col items-center gap-8 px-16 py-32 text-center">
							<strong className="text-body font-semibold text-ink">{t("automations.errors.config")}</strong>
							<p className="m-0 text-meta leading-body text-ink-muted [overflow-wrap:anywhere]">{state.configError}</p>
							<p className="m-0 text-meta leading-body text-ink-muted">{t("automations.errors.configHint")}</p>
						</div>
					) : !state.ready ? null : detail !== null ? (
						<AutomationDetail
							rule={detail}
							runs={history[detail.id]}
							onBack={() => onCancelEdit?.()}
							onRename={onRename}
							onUpdate={onUpdate}
							onDelete={() => onAskDelete(detail.id)}
							onDraftChange={onDraftChange}
						/>
					) : page === "all" ? (
						<AllRunsPage rules={state.rules} history={history} onOpen={open} onBack={() => setPage("list")} />
					) : state.rules.length === 0 ? (
						// Figma 672:3718: with no rules the page is only what the person's files suggest, and a way to ask in words.
						<section className="flex flex-col gap-10" data-automation-recommendations>
							<h2 className="m-0 mb-2 text-[15px] font-medium leading-[22px] text-ink">{t("automations.recs.title")}</h2>
							{recommendationCards}
							<p className="m-0 mt-6 flex items-center gap-8 text-meta leading-[18px] text-ink-muted">
								{t("automations.recs.more")}
								<button type="button" data-action="automation-talk" className="border-0 bg-transparent p-0 text-meta font-medium text-accent-text underline underline-offset-2 cursor-pointer" onClick={() => onTalk?.()}>
									{t("automations.recs.talk")}
								</button>
							</p>
						</section>
					) : (
						<>
							<section className="flex flex-col gap-8">
								<div className="flex items-center gap-8">
									<h2 className="m-0 flex-1 text-[14px] font-medium leading-[20px] text-ink">{t("automations.mine")}</h2>
									<button
										type="button"
										data-action="automation-composer-open"
										className="inline-flex h-28 flex-none items-center gap-4 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink cursor-pointer hover:bg-hover"
										onClick={() => onTalk?.()}
									>
										<TabPlusIcon size={13} />
										{t("automations.create.headButton")}
									</button>
								</div>
								{/* One soft shadow on the whole list, not on each row, so it lifts the group the same however many rules there are. */}
								<div role="grid" aria-label={t("automations.list")} className="flex flex-col overflow-hidden rounded-12 border border-border shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.04)] [&>[role=row]+[role=row]]:border-t-[0.5px] [&>[role=row]+[role=row]]:border-divider">
									{state.rules.map((rule) => (
										<RuleRow key={rule.id} rule={rule} selected={rule.id === selectedId} onSelect={onSelect} onOpen={open} onContextMenu={onContextMenu} />
									))}
								</div>
								<button type="button" data-action="automation-all-runs" className="self-start border-0 bg-transparent p-0 text-meta font-medium text-accent-text underline underline-offset-2 cursor-pointer" onClick={() => setPage("all")}>
									{t("automations.all.open")}
								</button>
							</section>
							{recommendations.length === 0 ? null : (
								<section className="flex flex-col gap-8" data-automation-recommendations>
									<h2 className="m-0 text-meta leading-[16px] text-ink-muted">{t("automations.recs.section")}</h2>
									{recommendationCards}
								</section>
							)}
						</>
					)}
				</div>
				</div>
			</div>
		</section>
	);
}
