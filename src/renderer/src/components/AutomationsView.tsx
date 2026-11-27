/**
 * The AI 에이전트 tab's 자동화 side (Figma 672:3718, 672:3740, 676:646, 676:790), one centred column in three places:
 * - the list: with no rules, 내 파일에서 찾은 자동화 (recommendations that open to show what they would do, and
 *   추가하기 writes one at once); with rules, 내 자동화 (status dot, name, when it runs, the switch, ›), 전체 기록 보기,
 *   and the recommendations not taken yet. 새 자동화 and 말로 만들기 open the AI chat column.
 * - a rule's own page (› on its row), under ‹ 뒤로가기: the name, which a click renames in place,
 *   the card to change and save it, and its 실행 기록 read from the rule's run log.
 * - 전체 기록, under ‹ 뒤로가기: every rule's runs, newest first, by day.
 * It only draws and reports: the rules come from the shared store, and delete asks before it removes anything.
 */

import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AutomationDraft, AutomationEventType, AutomationRule, AutomationRun, AutomationsSnapshot } from "../../../shared/automation-contract";
import type { FsLocation } from "../../../shared/fs-contract";
import type { LocaleKey } from "../../../shared/i18n/core";
import { cn } from "../lib/cn";
import { customRuleName, derivedTitle, failReason, folderLabel, kindsText, relativeTime, ruleTitle, runDotTone, runTone, whatText, whenText, type RunDotTone } from "../state/automations";
import { SparklesIcon, ChevronDownIcon, ChevronRightIcon, EyeIcon, FilePenIcon, FolderGlyph, PencilIcon, TabPlusIcon } from "./icons";
import { AgentSegment } from "./AgentSegment";
import { normalizeMagicAction, type MagicAction, type MagicActionSelectionRule } from "../../../shared/context-menu-contract";
import { hostPlatform } from "../lib/shortcuts";
import { DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, autoMagicLabel, rightClickKindOf, rightClickTarget, type RightClickKind } from "../state/right-click-trigger";
import { onMagicActionDone } from "../hooks/useMagicAction";
import { ConfirmDialog } from "./primitives/ConfirmDialog";
import { ChipSelect, type ChipOption } from "./primitives/ChipSelect";
import { RightClickWhen, rightClickSentence, type RunKind } from "./RightClickWhen";
import { openErrorFixDialog, startErrorFix, useErrorFixStore } from "../hooks/useErrorFix";
import { ErrorDetails } from "./ErrorDetails";
import { NoticeCard } from "./primitives/NoticeCard";
import { StatusDot } from "./primitives/StatusDot";
import { Switch } from "./primitives/Switch";

/**
 * Where the 자동화 tab is: the list or 전체 기록, a right-click action's page, and whether a rule's page was opened
 * from 전체 기록. Kept by the shell, so leaving the tab and coming back finds the page it was left on.
 */
export interface AutomationsPlace {
	readonly page: "list" | "all";
	readonly magicId: string | null;
	readonly fromAll: boolean;
}

export const INITIAL_AUTOMATIONS_PLACE: AutomationsPlace = { page: "list", magicId: null, fromAll: false };

export interface AutomationsViewProps {
	readonly state: AutomationsSnapshot;
	/** The rule being deleted: drawn faded and cannot be opened until it is gone. */
	readonly deletingId?: string | null;
	readonly daemonBusy: boolean;
	readonly selectedId: string | null;
	readonly onSelect: (id: string) => void;
	/** Double click or Enter: open an AI Search draft to edit the rule. */
	readonly onEdit: (id: string) => void;
	readonly onAdd: () => void;
	/** 만들기: write the rule; resolves true once it is in the rules file. */
	readonly onCreate: (draft: AutomationDraft) => Promise<boolean>;
	/** A 새 자동화 card set to 우클릭하면: add the action to the right-click menu; resolves true once settings have it. */
	readonly onCreateMagicAction?: ((action: MagicAction) => Promise<boolean>) | undefined;
	/** The right-click actions (Settings → 우클릭 메뉴), listed under 내 자동화 beside the rules. */
	readonly magicActions?: readonly MagicAction[];
	/** Where the tab was left; without it the tab keeps its place only while it is shown. */
	readonly place?: AutomationsPlace | undefined;
	readonly onPlaceChange?: ((place: AutomationsPlace) => void) | undefined;
	/** A right-click action's page saved a change (its name, 언제, 할 일, permission); resolves true once settings have it. */
	readonly onUpdateMagicAction?: ((action: MagicAction) => Promise<boolean>) | undefined;
	/** A right-click action's page, 삭제 confirmed: remove it from the right-click menu. */
	readonly onDeleteMagicAction?: ((id: string) => Promise<void>) | undefined;
	/** A folder automation row's switch: enable or pause the rule without removing it. */
	readonly onToggleRule?: ((id: string) => void) | undefined;
	/** A right-click row's switch: show or hide the action in the right-click menu. */
	readonly onToggleMagicAction?: ((id: string) => void) | undefined;
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

const TONE_DOT: Readonly<Record<RunDotTone, string>> = {
	ok: "--ok-dot",
	error: "--error-orange-dot",
	fail: "--danger-dot",
	never: "--text-faint",
};

/**
 * The status dot (Figma 672:3740): green after a clean run, orange when it could not start or finish, red when it ran
 * and failed, a filled grey one before any run.
 */
export function RunDot({ tone }: { readonly tone: RunDotTone }): ReactElement {
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
	image: IMAGE_EXTENSIONS.map((ext) => `**/*.${ext}`),
	document: DOCUMENT_EXTENSIONS.map((ext) => `**/*.${ext}`),
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

/** A recommendation a right-click starts: the action it would add to the right-click menu. */
interface RightClickTemplate {
	readonly id: "summary" | "translate";
	readonly clickKind: RightClickKind;
	readonly selection: MagicActionSelectionRule;
	readonly mode: ModeId;
}

/**
 * The page's recommendations, in order: a right-click automation that only reads (the automations tutorial adds it,
 * and its result shows at once), two folder automations, and a right-click one that writes, so both kinds of trigger are
 * on offer. 검색 바로 최신화 stays a template for the chat's suggestions but is not recommended here.
 */
type Recommendation = { readonly trigger: "folder"; readonly template: Template } | { readonly trigger: "rightClick"; readonly template: RightClickTemplate };

const RECOMMENDATIONS: readonly Recommendation[] = [
	{ trigger: "rightClick", template: { id: "summary", clickKind: "document", selection: "single", mode: "read" } },
	{ trigger: "folder", template: TEMPLATES[0]! },
	{ trigger: "folder", template: TEMPLATES[1]! },
	{ trigger: "rightClick", template: { id: "translate", clickKind: "document", selection: "single", mode: "write" } },
];

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
		<div ref={cardRef} className={cn("flex flex-col gap-8 rounded-12 bg-window p-14", pageMode && "border border-border")} data-testid="automation-new" data-editing={editing?.id}>
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
			<span className="mt-4 text-meta font-medium leading-[16px] text-ink-muted">{t(pageMode ? "automations.detail.task" : "automations.create.task")}</span>
			<textarea
				ref={taskRef}
				data-testid="automation-new-task"
				value={task}
				placeholder={t("automations.create.taskPlaceholder")}
				aria-label={t("automations.create.task")}
				className={cn(
					"h-60 resize-none rounded-10 border-[0.5px] border-divider bg-subtle-alt px-10 py-8 text-[13px] leading-[20px] outline-none placeholder:text-ink-faint",
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
	onToggle,
	onContextMenu,
	deleting = false,
}: {
	readonly rule: AutomationRule;
	readonly selected: boolean;
	/** Being deleted: faded, and a click, Enter or right click does nothing. */
	readonly deleting?: boolean;
	readonly onSelect: (id: string) => void;
	readonly onOpen: (id: string) => void;
	readonly onToggle?: ((id: string) => void) | undefined;
	readonly onContextMenu: AutomationsViewProps["onContextMenu"];
}): ReactElement {
	const { t } = useTranslation();
	const ref = useRef<HTMLDivElement>(null);
	const enabled = rule.enabled !== false;
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
			aria-disabled={deleting ? true : undefined}
			data-deleting={deleting ? "true" : undefined}
			data-enabled={enabled ? "true" : "false"}
			className={cn("flex items-center gap-14 py-10 pr-14 pl-16 select-none bg-window", deleting ? "pointer-events-none opacity-50" : "cursor-pointer hover:bg-hover-row")}
			onClick={() => {
				if (deleting) return;
				onSelect(rule.id);
				onOpen(rule.id);
			}}
			onContextMenu={(event: ReactMouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				onContextMenu(rule.id, { x: event.clientX, y: event.clientY });
			}}
		>
			{/* The same title and caption sizes as a recommendation's (Figma 672:3740): 14px over 12px. */}
			<div role="gridcell" className={cn("flex min-w-0 flex-1 flex-col gap-1", !enabled && "opacity-60")}>
				{/* Every automation looks alike here; what starts it is said by the line under the name. */}
				<span className="truncate text-[14px] font-medium leading-[20px] text-ink">{ruleTitle(rule)}</span>
				<span className="truncate text-meta leading-[17px] text-ink-muted">{whenText(rule)}</span>
			</div>
			<span role="presentation" className="flex flex-none items-center" onClick={(event) => event.stopPropagation()}>
				<Switch checked={enabled} onChange={() => onToggle?.(rule.id)} ariaLabel={t("automations.detail.runOn")} dataSwitchId={`automation-rule-on:${rule.id}`} />
			</span>
			<ChevronRightIcon size={14} className="flex-none text-ink-faint" />
		</div>
	);
}

/**
 * A right-click action in 내 자동화: the same row as a rule's — its name over when it shows ("PDF 파일 하나를 우클릭하면"),
 * the on/off switch, and ›, which opens its own page here in the tab.
 */
function MagicActionRow({
	action,
	onOpen,
	onToggle,
}: {
	readonly action: MagicAction;
	readonly onOpen: (id: string) => void;
	readonly onToggle?: ((id: string) => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div role="row" data-magic-action-row={action.id} data-enabled={action.enabled ? "true" : "false"} className="flex items-center gap-14 py-10 pr-14 pl-16 select-none bg-window cursor-pointer hover:bg-hover-row" onClick={() => onOpen(action.id)}>
			<div role="gridcell" className={cn("flex min-w-0 flex-1 flex-col gap-1", !action.enabled && "opacity-60")}>
				<span className="truncate text-[14px] font-medium leading-[20px] text-ink">{action.label}</span>
				<span className="truncate text-meta leading-[17px] text-ink-muted">{rightClickSentence(t, action)}</span>
			</div>
			<span role="presentation" className="flex flex-none items-center" onClick={(event) => event.stopPropagation()}>
				<Switch checked={action.enabled} onChange={() => onToggle?.(action.id)} ariaLabel={t("automations.magic.on")} dataSwitchId={`magic-action-on:${action.id}`} />
			</span>
			<ChevronRightIcon size={14} className="flex-none text-ink-faint" />
		</div>
	);
}

/** Right-click actions' runs from their log, newest first, read again whenever a run finishes. */
function useMagicRunHistory(ids: readonly string[]): Readonly<Record<string, readonly AutomationRun[]>> {
	const [history, setHistory] = useState<Readonly<Record<string, readonly AutomationRun[]>>>({});
	const [tick, setTick] = useState(0);
	useEffect(() => onMagicActionDone(() => setTick((count) => count + 1)), []);
	const key = ids.join("\n");
	useEffect(() => {
		const bridge = window.autorag?.magicAction;
		if (bridge === undefined || typeof bridge.history !== "function") return;
		let live = true;
		// The log is written as the run ends; a moment later it has the run that just finished.
		const read = (): void => {
			void Promise.all(ids.map(async (id) => [id, await bridge.history(id).catch(() => [] as readonly AutomationRun[])] as const)).then((entries) => {
				if (live) setHistory(Object.fromEntries(entries));
			});
		};
		read();
		const later = tick === 0 ? undefined : setTimeout(read, 400);
		return () => {
			live = false;
			clearTimeout(later);
		};
	}, [key, tick]);
	return history;
}

/** The name on a right-click action's page: the same field as a rule's — a click turns it into a field, Enter or leaving saves, Esc keeps it. */
function MagicTitle({ action, onRename }: { readonly action: MagicAction; readonly onRename: (label: string) => void }): ReactElement {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");
	const finish = (save: boolean): void => {
		setEditing(false);
		const next = name.trim();
		if (save && next.length > 0 && next !== action.label) onRename(next);
	};
	if (editing) {
		return (
			<input
				autoFocus
				data-testid="magic-title-input"
				value={name}
				aria-label={t("automations.row.rename")}
				className="h-28 min-w-0 flex-1 rounded-6 border border-accent bg-window px-6 text-[17px] font-medium leading-[22px] text-ink outline-none"
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
			data-action="magic-rename"
			title={t("automations.row.rename")}
			className="group inline-flex h-28 min-w-0 items-center gap-6 rounded-6 border-0 bg-transparent px-6 -mx-6 text-left cursor-text hover:bg-hover"
			onClick={() => {
				setName(action.label);
				setEditing(true);
			}}
		>
			<span className="truncate text-[17px] font-medium leading-[22px] text-ink">{action.label}</span>
			<PencilIcon size={14} className="flex-none text-ink-faint group-hover:text-ink-muted" />
		</button>
	);
}

/**
 * A right-click action's 설정 card: the rule page's card in the right-click form — 언제 as the sentence (the trigger
 * fixed), 할 일 with AI | 스크립트, and the permission chip. 취소 shows once something differs; 저장 waits for it.
 */
function MagicActionCard({ action, onSave }: { readonly action: MagicAction; readonly onSave: (next: MagicAction) => Promise<boolean> }): ReactElement {
	const { t } = useTranslation();
	const start = (): {
		kind: RightClickKind;
		custom: readonly string[] | null;
		selection: MagicActionSelectionRule;
		runKind: RunKind;
		task: string;
		mode: ModeId;
	} => {
		const { kind, custom } = rightClickKindOf(action.targetKind, action.extensions);
		return {
			kind,
			custom,
			selection: action.selection,
			runKind: action.execution.kind === "script" ? "script" : "agent",
			task: action.execution.kind === "script" ? action.execution.command : action.execution.prompt,
			mode: action.execution.kind === "agent" && action.execution.mode === "organize" ? "write" : "read",
		};
	};
	const [form, setForm] = useState(start);
	const [changed, setChanged] = useState(false);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		setForm(start());
		setChanged(false);
	}, [action.id, JSON.stringify(action)]);
	const set = <K extends keyof ReturnType<typeof start>>(key: K) => (value: ReturnType<typeof start>[K]): void => {
		setForm((current) => ({ ...current, [key]: value }));
		setChanged(true);
	};
	const script = form.runKind === "script";
	const modes: readonly ChipOption<ModeId>[] = [
		{ value: "read", label: t("automations.create.mode.read"), icon: <EyeIcon size={13} /> },
		{ value: "write", label: t("automations.create.mode.write"), icon: <FilePenIcon /> },
	];
	const save = async (): Promise<void> => {
		const next = normalizeMagicAction({
			...action,
			selection: form.selection,
			...rightClickTarget(form.kind, form.custom),
			execution: script
				? { kind: "script", command: form.task }
				: {
						kind: "agent",
						mode: form.mode === "write" ? "organize" : "read",
						prompt: form.task,
						useSkills: action.execution.kind === "agent" ? action.execution.useSkills !== false : true,
						useMcp: action.execution.kind === "agent" ? action.execution.useMcp !== false : true,
					},
		});
		if (next === null || busy) return;
		setBusy(true);
		const ok = await onSave(next);
		setBusy(false);
		if (ok) setChanged(false);
	};
	return (
		<div className="flex flex-col gap-8 rounded-[14px] border border-border bg-window p-14" data-magic-action-card={action.id}>
			<span className="text-meta font-medium leading-[16px] text-ink-muted">{t("automations.create.when")}</span>
			<RightClickWhen
				kind={form.kind}
				custom={form.custom}
				selection={form.selection}
				testId="magic-detail-rc"
				onKind={(kind) => {
					setForm((current) => ({ ...current, kind, custom: null }));
					setChanged(true);
				}}
				onCustom={set("custom")}
				onSelection={set("selection")}
			/>
			{/* No AI | 스크립트 choice: an action stays what it was made as (the assistant decides that when it makes one). */}
			<span className="mt-4 flex h-22 items-center text-meta font-medium leading-[16px] text-ink-muted">{t("automations.detail.task")}</span>
			<textarea
				data-testid="magic-detail-task"
				value={form.task}
				aria-label={t("automations.create.task")}
				placeholder={
					script
						? t(hostPlatform() === "win32" ? "settingsCore.contextMenu.editor.commandPlaceholderWindows" : "settingsCore.contextMenu.editor.commandPlaceholder")
						: t("automations.create.taskPlaceholder")
				}
				className={cn(
					"h-60 resize-none rounded-10 border-[0.5px] border-divider bg-subtle-alt px-10 py-8 text-[13px] leading-[20px] text-ink outline-none placeholder:text-ink-faint focus:border-accent",
					script && "font-mono text-[12px]",
				)}
				onChange={(change) => set("task")(change.target.value)}
			/>
			<div className="flex items-center gap-6">
				{script ? null : <ChipSelect value={form.mode} options={modes} label={t("automations.create.modeLabel")} round testId="magic-detail-mode" onChange={set("mode")} />}
				<span className="flex-1" />
				{changed ? (
					<button
						type="button"
						data-action="magic-detail-cancel"
						className="mr-6 inline-flex h-32 items-center border-0 bg-transparent p-0 text-meta text-ink-muted cursor-pointer hover:text-ink"
						onClick={() => {
							setForm(start());
							setChanged(false);
						}}
					>
						{t("common.cancel")}
					</button>
				) : null}
				<button
					type="button"
					data-action="magic-detail-save"
					disabled={!changed || form.task.trim().length === 0}
					className="inline-flex h-32 items-center justify-center rounded-6 border-0 bg-accent px-12 text-meta font-medium text-on-accent cursor-pointer disabled:cursor-default disabled:opacity-50"
					onClick={() => void save()}
				>
					{t("common.save")}
				</button>
			</div>
		</div>
	);
}

/** A right-click action's own page, laid out as a rule's: the path back, the name and switch, its 설정 card, its 실행 기록, and 삭제. */
function MagicActionDetail({
	action,
	runs,
	crumbs,
	onUpdate,
	onToggle,
	onDelete,
	onOpenFolder,
}: {
	readonly action: MagicAction;
	readonly runs: readonly AutomationRun[] | undefined;
	readonly crumbs: readonly Crumb[];
	readonly onUpdate: (next: MagicAction) => Promise<boolean>;
	readonly onToggle?: ((id: string) => void) | undefined;
	readonly onDelete: () => void;
	readonly onOpenFolder?: ((path: string) => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const list = runs ?? [];
	return (
		<div className="flex flex-col gap-24" data-magic-action-detail={action.id}>
			<div className="flex flex-col gap-6">
				<Breadcrumb crumbs={crumbs} current={action.label} />
				<div className="flex min-w-0 items-center gap-8">
					<MagicTitle key={action.id} action={action} onRename={(label) => void onUpdate({ ...action, label })} />
					<span className="flex-1" />
					<span className="flex-none text-badge leading-[16px] text-ink-muted">{t("automations.detail.runOn")}</span>
					<Switch checked={action.enabled} onChange={() => onToggle?.(action.id)} ariaLabel={t("automations.magic.on")} dataSwitchId={`magic-detail-on:${action.id}`} />
				</div>
			</div>
			<Section muted title={t("automations.detail.settings")}>
				<MagicActionCard action={action} onSave={onUpdate} />
			</Section>
			<Section muted title={list.length === 0 ? t("automations.detail.history") : `${t("automations.detail.history")} (${list.length})`}>
				{list.length === 0 ? (
					<p className="m-0 border-t-[0.5px] border-divider py-20 text-meta leading-[16px] text-ink-faint" data-runs-empty>{t("automations.inspector.noRuns")}</p>
				) : (
					<div role="list" aria-label={t("automations.detail.history")} className="flex flex-col border-y-[0.5px] border-divider [&>*+*]:border-t-[0.5px] [&>*+*]:border-divider">
						{list.map((run) => (
							<RunLine key={`${run.startedAt}-${run.durationMs}`} run={run} absoluteTime onOpen={openRunFolder(run, onOpenFolder)} flat />
						))}
					</div>
				)}
			</Section>
			<div className="flex justify-end">
				<button type="button" data-action="magic-delete" className="border-0 bg-transparent p-0 text-meta font-medium text-danger-text cursor-pointer hover:opacity-80" onClick={onDelete}>
					{t("automations.detail.delete")}
				</button>
			</div>
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

/** Which kind of automation a row is: a folder rule or a right-click (magic) action. */
type AutomationKind = "rule" | "magic";

const baseName = (path: string): string => path.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? path;
const parentDir = (path: string): string => {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut <= 0 ? path : path.slice(0, cut);
};

/** What a run is named by: the file it ran on ("회의록.txt", "회의록.txt 외 2개"), or how many when the log has no names. */
function runFilesTitle(run: AutomationRun, t: TFunction): string | null {
	const first = run.files?.[0];
	if (first !== undefined) {
		const name = baseName(first);
		const rest = (run.files?.length ?? 1) - 1;
		return rest === 0 ? name : t("automations.inspector.runFilesMore", { name, count: rest });
	}
	return run.eventCount > 0 ? t("automations.inspector.runFiles", { count: run.eventCount }) : null;
}

/** How a run ended, as a word: 완료, or why it failed (시간 초과, …). */
function runResult(run: AutomationRun, t: TFunction): string {
	return runTone(run) === "ok" ? t("automations.inspector.runDone") : failReason(run);
}

/** When a run started, on a rule's own page (Figma 676:835): 오늘 14:02, 어제 10:41, or the date. */
function runAt(at: number, t: TFunction, language: string, now: number = Date.now()): string {
	const start = (time: number): number => new Date(time).setHours(0, 0, 0, 0);
	const days = Math.round((start(now) - start(at)) / 86_400_000);
	const time = new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
	if (days === 0) return t("automations.time.todayAt", { time });
	if (days === 1) return t("automations.time.yesterdayAt", { time });
	return new Intl.DateTimeFormat(language, { month: "long", day: "numeric" }).format(at);
}

/**
 * One line of 실행 기록 / 전체 기록 (Figma 699:3562, 676:835): the dot, the file the run worked on,
 * and under it, in 전체 기록, the automation's name and how it ended ("핵심 요약 · 시간 초과"), or on the automation's own
 * page just how it ended. Then when, and › when the line opens something: its automation from 전체 기록, the file's folder
 * on a page. A failed run on its own page shows the error it left.
 */
function RunLine({
	run,
	name,
	onOpen,
	absoluteTime = false,
	flat = false,
}: {
	readonly run: AutomationRun;
	/** The automation's name, in 전체 기록, where runs of every automation are mixed. */
	readonly name?: string;
	readonly onOpen?: (() => void) | undefined;
	/** On an automation's own page the time reads 오늘 14:02, in 전체 기록 3분 전. */
	readonly absoluteTime?: boolean;
	readonly flat?: boolean;
}): ReactElement {
	const { t, i18n } = useTranslation();
	const tone = runTone(run);
	const result = runResult(run, t);
	const files = runFilesTitle(run, t);
	const first = files ?? (name ?? result);
	const second = name !== undefined ? `${name} · ${result}` : files === null ? null : result;
	const body = (
		<>
			<div className="flex w-full items-center gap-10">
				<RunDot tone={runDotTone(run)} />
				<div className="flex min-w-0 flex-1 flex-col gap-px">
					<span className="truncate text-[13px] leading-[20px] text-ink" data-run-title>{first}</span>
					{second === null ? null : <span className="truncate text-[12px] leading-[18px] text-ink-muted" data-run-caption>{second}</span>}
				</div>
				<span className="flex-none text-meta leading-[18px] text-ink-muted">{absoluteTime ? runAt(run.startedAt, t, i18n.language) : relativeTime(run.startedAt)}</span>
				{onOpen === undefined ? null : <ChevronRightIcon size={14} className="flex-none text-ink-faint" />}
			</div>
			{tone === "fail" && run.error !== undefined && name === undefined ? (
				<p className="m-0 w-full rounded-8 bg-subtle-alt px-10 py-7 text-meta leading-[18px] text-ink-body [overflow-wrap:anywhere]">{run.error}</p>
			) : null}
		</>
	);
	// On an automation's own page the runs are plain lines between hairlines (Figma 641:13600); in 전체 기록 they sit in the rounded list.
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

/** On an automation's own page a run that names its files opens their folder; one that only counts them opens nothing. */
function openRunFolder(run: AutomationRun, onOpenFolder: ((path: string) => void) | undefined): (() => void) | undefined {
	const first = run.files?.[0];
	return first === undefined || onOpenFolder === undefined ? undefined : () => onOpenFolder(parentDir(first));
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
	const fallbackName = ruleTitle({ ...rule, id: rule.id });
	const start = (): void => {
		setName(customRuleName(rule) ?? ruleTitle(rule));
		setEditing(true);
	};
	const finish = (save: boolean): void => {
		setEditing(false);
		const trimmed = name.trim();
		const defaultTitle = customRuleName(rule) === null ? ruleTitle(rule) : derivedTitle(rule);
		const next = trimmed === defaultTitle || trimmed === rule.id || trimmed === derivedTitle(rule) ? "" : trimmed;
		if (save && next !== (customRuleName(rule) ?? "")) void onRename?.(rule.id, next);
	};
	if (editing) {
		return (
			<input
				autoFocus
				data-testid="automation-title-input"
				value={name}
				placeholder={fallbackName}
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

/** A rule's own page (Figma 621:4882): the path back (자동화 › 전체 기록), the name, the card to change it, and its 실행 기록. */
function AutomationDetail({
	rule,
	runs,
	crumbs,
	onRename,
	onUpdate,
	onToggle,
	onDelete,
	onDraftChange,
	onOpenFolder,
}: {
	readonly rule: AutomationRule;
	readonly runs: readonly AutomationRun[] | undefined;
	readonly crumbs: readonly Crumb[];
	readonly onRename: AutomationsViewProps["onRename"];
	readonly onUpdate: AutomationsViewProps["onUpdate"];
	readonly onToggle?: ((id: string) => void) | undefined;
	readonly onDelete: () => void;
	readonly onDraftChange: AutomationsViewProps["onDraftChange"];
	readonly onOpenFolder?: ((path: string) => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const enabled = rule.enabled !== false;
	// The log is the record; until it has been read (or if it is gone) the rule's last run still shows.
	const list = runs !== undefined && runs.length > 0 ? runs : rule.lastRun === null ? [] : [rule.lastRun];
	return (
		<div className="flex flex-col gap-24" data-automation-detail={rule.id}>
			<div className="flex flex-col gap-6">
				<Breadcrumb crumbs={crumbs} current={ruleTitle(rule)} />
				<div className="flex min-w-0 items-center gap-8">
					<EditableTitle key={rule.id} rule={rule} onRename={onRename} />
					<span className="flex-1" />
					<span className="flex-none text-badge leading-[16px] text-ink-muted">{t("automations.detail.runOn")}</span>
					<Switch checked={enabled} onChange={() => onToggle?.(rule.id)} ariaLabel={t("automations.detail.runOn")} dataSwitchId="automation-detail-on" />
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
							<RunLine key={`${run.startedAt}-${run.durationMs}`} run={run} absoluteTime onOpen={openRunFolder(run, onOpenFolder)} flat />
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

/** One step of the path above a page under the list. */
interface Crumb {
	readonly label: string;
	readonly action: string;
	readonly onClick: () => void;
}

/**
 * Where a page under the list sits (자동화 › 전체 기록 › the rule): each earlier step takes the person straight to that
 * page, quiet until hovered; the last step names the page they are on and is not a link.
 */
function Breadcrumb({ crumbs, current }: { readonly crumbs: readonly Crumb[]; readonly current: string }): ReactElement {
	return (
		<nav aria-label="breadcrumb" className="flex min-w-0 max-w-full flex-none items-center gap-4 self-start text-meta leading-[16px] text-ink-muted">
			{crumbs.map((crumb, index) => (
				<Fragment key={crumb.action}>
					{index === 0 ? null : <ChevronRightIcon size={11} className="flex-none text-ink-faint" />}
					<button type="button" data-action={crumb.action} className="border-0 bg-transparent p-0 text-meta leading-[16px] text-ink-muted cursor-pointer hover:text-ink" onClick={crumb.onClick}>
						{crumb.label}
					</button>
				</Fragment>
			))}
			<ChevronRightIcon size={11} className="flex-none text-ink-faint" />
			<span aria-current="page" className="min-w-0 truncate text-ink-body" data-crumb-current>
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

/** One run in 전체 기록, from a rule or a right-click action. */
interface RunEntry {
	readonly key: string;
	readonly kind: AutomationKind;
	readonly id: string;
	readonly name: string;
	readonly run: AutomationRun;
}

/**
 * 전체 기록 (Figma 699:3562): every automation's runs — folder rules' and right-click actions' — newest first, under the
 * day they ran. A row names the file and, under it, the automation and how it ended; › opens that automation's page.
 */
function AllRunsPage({ entries, onOpen, crumbs }: { readonly entries: readonly RunEntry[]; readonly onOpen: (entry: RunEntry) => void; readonly crumbs: readonly Crumb[] }): ReactElement {
	const { t, i18n } = useTranslation();
	const all = [...entries].sort((a, b) => b.run.startedAt - a.run.startedAt);
	const days: { label: string; runs: RunEntry[] }[] = [];
	for (const item of all) {
		const label = dayLabel(item.run.startedAt, t, i18n.language);
		const last = days[days.length - 1];
		if (last !== undefined && last.label === label) last.runs.push(item);
		else days.push({ label, runs: [item] });
	}
	return (
		<section className="flex flex-col gap-6" data-automation-all-runs>
			<Breadcrumb crumbs={crumbs} current={t("automations.all.title")} />
			{/* The same 28px row as an automation's renamable title, so the breadcrumb and title line up page to page. */}
			<h1 className="m-0 flex h-28 items-center text-[17px] font-medium leading-[22px] text-ink">{t("automations.all.title")}</h1>
			{all.length === 0 ? (
				<p className="m-0 mt-18 border-t-[0.5px] border-divider py-20 text-meta leading-[16px] text-ink-faint" data-runs-empty>{t("automations.inspector.noRuns")}</p>
			) : (
				<div className="mt-10 flex flex-col gap-18">
					{days.map((day) => (
						<div key={day.label} className="flex flex-col">
							<h2 className="m-0 border-b-[0.5px] border-divider pb-6 text-meta font-medium leading-[16px] text-ink-muted">{day.label}</h2>
							<div role="list" aria-label={day.label} className="flex flex-col border-b-[0.5px] border-divider [&>*+*]:border-t-[0.5px] [&>*+*]:border-divider">
								{day.runs.map((entry) => (
									<RunLine key={entry.key} run={entry.run} name={entry.name} onOpen={() => onOpen(entry)} flat />
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

/** The names the OS gives a screenshot it saves (macOS, Windows, in the four interface languages). */
const SCREENSHOT_NAME = /^(screenshot|screen shot|스크린샷|スクリーンショット|屏幕截图|截屏)/i;
const IMAGE_FILE = /.(png|jpe?g|heic|gif|webp)$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How many files directly in `path` pass `keep`; null when the folder cannot be read. */
async function countFiles(path: string, keep: (entry: { readonly name: string; readonly mtimeMs: number }) => boolean): Promise<number | null> {
	try {
		const listing = await window.autorag.fs.listDir(path);
		return listing.entries.filter((entry) => entry.kind === "file" && keep(entry)).length;
	} catch {
		return null;
	}
}

/**
 * Why each recommendation is worth having, read from the person's own files (Figma 672:3718): how many PDFs sit in
 * Downloads, how many screenshots on the Desktop still have the name the OS gave them, and how long ago Documents last
 * reached search (or, when this app has not seen an index run, how many of its files changed this week). A template
 * with nothing to point at gets no reason, and its card falls back to when it would run.
 */
type Reasons = Readonly<Partial<Record<TemplateId, string>>>;

/** The reasons last counted, so coming back to the page shows them at once instead of counting from nothing. */
let lastReasons: Reasons | null = null;

/**
 * Why each recommendation is worth having, counted from the person's folders; null until the first count is in, so a
 * card does not show its fallback (when it would run) for a moment and then swap it for the reason.
 */
function useRecommendationReasons(locations: readonly FsLocation[]): Reasons | null {
	const { t } = useTranslation();
	const [reasons, setReasons] = useState<Reasons | null>(lastReasons);
	useEffect(() => {
		// The places are not known yet: counting now would find nothing and flash the fallback.
		if (locations.length === 0) return;
		let live = true;
		const folder = (icon: Template["folder"]): string | null => locations.find((location) => location.icon === icon && location.available)?.path ?? null;
		const downloads = folder("downloads");
		const desktop = folder("desktop");
		const documents = folder("documents");
		void (async () => {
			const next: Partial<Record<TemplateId, string>> = {};
			const pdfs = downloads === null ? null : await countFiles(downloads, (entry) => /.pdf$/i.test(entry.name));
			if (pdfs !== null && pdfs > 0) next.pdf = t("automations.recs.reason.pdf", { count: pdfs });
			const shots = desktop === null ? null : await countFiles(desktop, (entry) => IMAGE_FILE.test(entry.name) && SCREENSHOT_NAME.test(entry.name));
			if (shots !== null && shots > 0) next.screenshot = t("automations.recs.reason.screenshot", { count: shots });
			const finished = await window.autorag?.indexActivity
				?.get()
				.then((snapshot) => (snapshot.finishedAt === null ? null : Date.parse(snapshot.finishedAt)))
				.catch(() => null);
			if (finished !== null && finished !== undefined && Number.isFinite(finished) && Date.now() - finished >= DAY_MS) {
				next.refresh = t("automations.recs.reason.refreshAgo", { time: relativeTime(finished) });
			} else if (documents !== null) {
				const weekAgo = Date.now() - 7 * DAY_MS;
				const changed = await countFiles(documents, (entry) => entry.mtimeMs >= weekAgo);
				if (changed !== null && changed > 0) next.refresh = t("automations.recs.reason.refreshChanged", { count: changed });
			}
			lastReasons = next;
			if (live) setReasons(next);
		})();
		return () => {
			live = false;
		};
	}, [locations, t]);
	return reasons;
}

/**
 * One recommendation (Figma 672:3718): the chevron, its name over why it is worth having, and 추가하기. A click on the
 * row opens it downward to show what it would do, read-only (언제, 할 일); 추가하기 writes it at once, open or not.
 */
function RecommendationCard({
	id,
	when,
	task,
	canAdd,
	reason,
	glow = false,
	quiet = false,
	onAdd,
}: {
	/** The template's id: its words in `automations.templates.<id>`. */
	readonly id: string;
	/** When it would run, as the automation's own sentence (a folder's change, or a right-click). */
	readonly when: string;
	readonly task: string;
	/** False until it can be written (a folder automation waits for the OS to say where its folder is). */
	readonly canAdd: boolean;
	/** Once there are rules the recommendations step back: a row in one grouped list on a faint ground, no stroke, smaller words. */
	readonly quiet?: boolean;
	/** While there are no rules the recommendations are the page's invitation: a soft aurora sits behind each card. */
	readonly glow?: boolean;
	/** Why it is worth having, from the person's files; without one the card says when it would run; null while counting. */
	readonly reason: string | undefined | null;
	/** 추가하기: write it as a folder rule or a right-click action. */
	readonly onAdd: () => Promise<boolean>;
}): ReactElement {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const card = (
		<div
			className={cn("flex flex-col", quiet ? "gap-10 py-10 pr-14 pl-16" : cn("gap-12 rounded-12 border bg-window px-16 py-14", glow ? "border-transparent" : "border-border"))}
			data-template={id}
			data-open={open ? "true" : undefined}
		>
			<div className="flex items-center gap-10">
				<button
					type="button"
					aria-expanded={open}
					className="flex min-w-0 flex-1 items-center gap-10 border-0 bg-transparent p-0 text-left cursor-pointer"
					onClick={() => setOpen((was) => !was)}
				>
					<ChevronDownIcon size={13} className={cn("flex-none text-ink-faint transition-transform duration-(--dur-color)", open && "rotate-180")} />
					<span className="flex min-w-0 flex-1 flex-col gap-2">
						<span className={cn("truncate text-ink", quiet ? "text-[13px] leading-[17px]" : "text-[14px] font-medium leading-[17px]")}>{t(`automations.templates.${id}.title` as LocaleKey)}</span>
						{/* While the reasons are being counted the line keeps its height and shows nothing yet. */}
						<span className="truncate text-meta leading-[14px] text-ink-muted" data-recommendation-reason={reason === undefined || reason === null ? undefined : "true"}>
							{reason === null ? "\u00a0" : (reason ?? when)}
						</span>
					</span>
				</button>
				<button
					type="button"
					data-action="automation-template-add"
					disabled={!canAdd || busy}
					className={cn(
						"inline-flex flex-none items-center rounded-6 border px-10 text-meta font-medium cursor-pointer disabled:cursor-default disabled:opacity-50",
						quiet ? "h-26" : "h-28",
						open ? "border-accent bg-accent text-on-accent hover:border-accent-hover hover:bg-accent-hover" : "border-border bg-window text-ink-body hover:bg-hover",
					)}
					onClick={() => {
						if (!canAdd) return;
						setBusy(true);
						void onAdd().finally(() => setBusy(false));
					}}
				>
					{t("automations.recs.add")}
				</button>
			</div>
			{open ? (
				<dl className={cn("m-0 grid grid-cols-[minmax(40px,auto)_1fr] gap-x-12 gap-y-6 rounded-8 px-12 py-10 text-meta leading-[14px] [&>dt]:whitespace-nowrap", quiet ? "bg-window" : "bg-subtle-alt")}>
					<dt className="text-ink-muted">{t("automations.create.when")}</dt>
					<dd className="m-0 text-ink">{when}</dd>
					<dt className="text-ink-muted">{t("automations.create.task")}</dt>
					<dd className="m-0 text-ink">{task}</dd>
				</dl>
			) : null}
		</div>
	);
	return glow ? (
		// Lower than the composer's glow: it invites, it does not call.
		<div className="ai-glow-host [--ai-glow-opacity:0.28] [--ai-glow-opacity-focus:0.36] [--ai-glow-blur:14px]" data-ai-glow>
			<div className="ai-glow ai-glow-warm" aria-hidden="true" />
			{card}
		</div>
	) : (
		card
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

/**
 * The rule the agent is about to save, filled in (Figma 672:3740): the 언제 sentence of chips over the 할 일 line, or
 * the command a program rule runs, read as it is. A folder, kind or change the chips do not offer stays as written
 * until its chip is changed.
 *
 * The change chip also offers 우클릭하면 when the card is handed `onCreateMagicAction`: the sentence then drops the
 * folder for how many items are picked ("PDF 파일 하나를 우클릭하면"), 할 일 can be a command instead (AI | 스크립트),
 * and 추가하기 puts the action in the right-click menu instead of the automation list. One form for both triggers.
 * `rightClickOnly` (Settings → 우클릭 메뉴's 매직 액션 만들기) starts it there and reads the trigger as plain text.
 */
export function AutomationDraftCard({
	initial,
	initialMagicAction = null,
	onCreate,
	onCreateMagicAction,
	onCancel,
	rightClickOnly = false,
	submitLabel,
}: {
	/** The rule to show filled in; null for an empty card (새 자동화) where every chip still asks. */
	readonly initial: AutomationDraft | null;
	/** A prefilled right-click automation (from the agent's confirmation request); locks the card to right-click mode. */
	readonly initialMagicAction?: MagicAction | null;
	readonly onCreate: (draft: AutomationDraft) => Promise<boolean>;
	/** Where a right-click action can be made from here; without it the change chip has no 우클릭하면. */
	readonly onCreateMagicAction?: ((action: MagicAction) => Promise<boolean>) | undefined;
	readonly onCancel: () => void;
	/** Only a right-click action can be made here: the card opens on 우클릭하면 and the trigger cannot change. */
	readonly rightClickOnly?: boolean;
	/** Optional override for the primary button text (defaults to 추가하기). */
	readonly submitLabel?: string;
}): ReactElement {
	const { t } = useTranslation();
	const locations = useLocations();
	const blank = initial === null;
	const lockedRightClick = rightClickOnly || initialMagicAction !== null;
	const initialClick = initialMagicAction === null ? null : rightClickKindOf(initialMagicAction.targetKind, initialMagicAction.extensions);
	const rule: AutomationDraft = initial ?? { paths: [], events: [], include: [], agent: { profile: PROFILES.read, task: "" } };
	const first = rule.paths[0] ?? null;
	const [folder, setFolder] = useState<string | null>(first);
	const [kind, setKind] = useState<KindId | null>(blank ? null : kindOf(rule.include));
	const [event, setEvent] = useState<EventId | "rightClick" | null>(lockedRightClick ? "rightClick" : blank ? null : eventOf(rule.events));
	const [task, setTask] = useState(
		initialMagicAction !== null
			? initialMagicAction.execution.kind === "agent"
				? initialMagicAction.execution.prompt
				: ""
			: (rule.agent?.task ?? ""),
	);
	const [busy, setBusy] = useState(false);
	// 우클릭하면: its own file kinds (folders too), how many items, and a typed extension list.
	const rightClick = event === "rightClick";
	const [clickKind, setClickKind] = useState<RightClickKind>(initialClick?.kind ?? "pdf");
	const [customExtensions, setCustomExtensions] = useState<readonly string[] | null>(initialClick?.custom ?? null);
	const [selection, setSelection] = useState<MagicActionSelectionRule>(initialMagicAction?.selection ?? "single");
	const standard = standardFolders(locations);
	const folders = folder === null || standard.some((option) => option.value === folder) ? standard : [...standard, { value: folder, label: folderLabel(folder), icon: <FolderGlyph size={13} /> }];
	const draft: AutomationDraft | null =
		event === "rightClick" || folder === null || (blank && (kind === null || event === null))
			? null
			: {
					paths: folder === first ? rule.paths : [folder],
					events: event === null ? rule.events : EVENTS[event],
					include: kind === null ? rule.include : KIND_GLOBS[kind],
					...(rule.agent === undefined ? { run: rule.run ?? [] } : { agent: { profile: rule.agent.profile, task: task.trim() } }),
				};
	const kinds: readonly ChipOption<KindId>[] = (["all", "pdf", "image", "document"] as const).map((value) => ({ value, label: t(`automations.create.kind.${value}`) }));
	// A program rule the agent wrote stays a folder rule; anything else may become a right-click action.
	const offersRightClick = onCreateMagicAction !== undefined && rule.agent !== undefined;
	const events: readonly ChipOption<EventId | "rightClick">[] = [
		...(["create", "update", "createUpdate", "delete"] as const).map((value) => ({ value, label: t(`automations.create.event.${value}`) })),
		...(offersRightClick ? [{ value: "rightClick" as const, label: t("rightClickWhen.event"), divided: true }] : []),
	];
	const chips: Readonly<Record<string, ReactNode>> = {
		folder: <ChipSelect value={folder} options={folders} label={folder === null ? t("automations.create.pickFolder") : folderLabel(folder)} icon={<FolderGlyph size={13} />} testId="automation-request-folder" onChange={setFolder} />,
		kind: <ChipSelect value={kind} options={kinds} label={kind === null && !blank ? t("automations.kinds.noun", { kinds: kindsText(rule.include) }) : t("automations.create.kindLabel")} testId="automation-request-kind" onChange={setKind} />,
		event: <ChipSelect value={event} options={events} label={event === null && !blank ? t("automations.create.event.other") : t("automations.create.eventLabel")} testId="automation-request-event" onChange={setEvent} />,
	};
	const sentence = t("automations.create.sentence", { folder: "\u0000folder\u0000", kind: "\u0000kind\u0000", event: "\u0000event\u0000" }).split("\u0000");
	const scriptCommand = initialMagicAction?.execution.kind === "script" ? initialMagicAction.execution.command : null;
	const showsCommand = rightClick ? scriptCommand !== null : rule.agent === undefined;
	const commandText = rightClick ? (scriptCommand ?? "") : (rule.run ?? []).join(" ");
	const canSubmit =
		(rightClick
			? scriptCommand !== null
				? scriptCommand.trim().length > 0
				: task.trim().length > 0
			: draft !== null && (rule.agent === undefined ? (rule.run?.length ?? 0) > 0 : task.trim().length > 0)) && !busy;
	/** 우클릭하면: the card as the right-click menu action it makes, named from what it does. */
	const magicAction = (): MagicAction | null =>
		initialMagicAction !== null
			? normalizeMagicAction({
					id: initialMagicAction.id,
					label: initialMagicAction.label.trim() || autoMagicLabel(task),
					...(initialMagicAction.description === undefined ? {} : { description: initialMagicAction.description }),
					enabled: initialMagicAction.enabled,
					selection,
					...rightClickTarget(clickKind, customExtensions),
					execution:
						initialMagicAction.execution.kind === "script"
							? initialMagicAction.execution
							: { ...initialMagicAction.execution, prompt: task },
				})
			: normalizeMagicAction({
					label: autoMagicLabel(task),
					enabled: true,
					selection,
					...rightClickTarget(clickKind, customExtensions),
					// The card always asks the agent; a script action is made by asking the assistant, which decides.
					execution: { kind: "agent", mode: rule.agent?.profile === PROFILES.write ? "organize" : "read", prompt: task },
				});
	return (
		<div className="flex flex-col gap-8 rounded-12 border border-divider bg-window p-12" data-automation-request>
			{initialMagicAction !== null && initialMagicAction.label.trim().length > 0 ? (
				<strong className="text-meta font-semibold leading-[18px] text-ink" data-testid="automation-request-label">
					{initialMagicAction.label}
				</strong>
			) : null}
			<span className="text-badge leading-[15px] text-ink-muted">{t("automations.create.when")}</span>
			{rightClick ? (
				<RightClickWhen
					kind={clickKind}
					custom={customExtensions}
					selection={selection}
					event={lockedRightClick ? undefined : chips.event}
					className="flex flex-wrap items-center gap-6"
					testId="automation-request-rc"
					onKind={(next) => {
						setClickKind(next);
						setCustomExtensions(null);
					}}
					onCustom={setCustomExtensions}
					onSelection={setSelection}
				/>
			) : (
				<div className="flex flex-wrap items-center gap-6">
					{sentence.map((part, index) =>
						part in chips ? <Fragment key={index}>{chips[part]}</Fragment> : part.trim().length === 0 ? null : <span key={index} className="text-meta leading-[18px] text-ink-muted">{part.trim()}</span>,
					)}
				</div>
			)}
			<span className="text-badge leading-[15px] text-ink-muted">{showsCommand ? t("automations.request.command") : t("automations.create.task")}</span>
			{showsCommand ? (
				<code className="block rounded-6 bg-subtle-alt px-8 py-6 font-mono text-badge leading-[16px] text-ink [overflow-wrap:anywhere]" data-testid="automation-request-command">
					{commandText}
				</code>
			) : (
				<textarea
					value={task}
					rows={2}
					aria-label={t("automations.create.task")}
					placeholder={t("automations.create.taskPlaceholder")}
					data-testid="automation-request-task"
					className="w-full resize-none rounded-6 border-[0.5px] border-divider bg-subtle-alt px-8 py-6 text-meta leading-[18px] text-ink outline-none focus:border-accent"
					onChange={(change) => setTask(change.target.value)}
				/>
			)}
			<div className="flex items-center justify-end gap-12">
				<button type="button" data-action="automation-request-cancel" className="border-0 bg-transparent p-0 text-meta text-ink-muted cursor-pointer hover:text-ink" onClick={onCancel}>
					{t("common.cancel")}
				</button>
				<button
					type="button"
					data-action="automation-request-add"
					disabled={!canSubmit}
					className="inline-flex h-28 items-center rounded-6 border-0 bg-accent px-10 text-meta font-medium text-on-accent cursor-pointer hover:bg-accent-hover disabled:cursor-default disabled:opacity-50"
					onClick={() => {
						if (rightClick) {
							const action = magicAction();
							if (action === null || onCreateMagicAction === undefined) return;
							setBusy(true);
							void onCreateMagicAction(action).finally(() => setBusy(false));
							return;
						}
						if (draft === null) return;
						setBusy(true);
						void onCreate(draft).finally(() => setBusy(false));
					}}
				>
					{submitLabel ?? t("automations.recs.add")}
				</button>
			</div>
		</div>
	);
}

export function AutomationsView({ state, deletingId = null, selectedId, onSelect, onEdit, onAskDelete, onRename, onCreate, onUpdate, onCancelEdit, editing = null, onDraftChange, onContextMenu, onRetryStatus, onShowChat, onTalk, onOpenFolder, magicActions = [], onCreateMagicAction, onToggleRule, onToggleMagicAction, onUpdateMagicAction, onDeleteMagicAction, place: keptPlace, onPlaceChange }: AutomationsViewProps): ReactElement {
	const { t } = useTranslation();
	// Which page the tab shows lives with the shell when it is given one, so coming back to the tab finds it again.
	const [ownPlace, setOwnPlace] = useState<AutomationsPlace>(keptPlace ?? INITIAL_AUTOMATIONS_PLACE);
	const place = keptPlace ?? ownPlace;
	// Several steps can change the place in one handler (leave 전체 기록, then open a page): each builds on the last.
	const placeRef = useRef(place);
	placeRef.current = place;
	const movePlace = (change: Partial<AutomationsPlace>): void => {
		const next = { ...placeRef.current, ...change };
		placeRef.current = next;
		if (onPlaceChange === undefined) setOwnPlace(next);
		else onPlaceChange(next);
	};
	const { page, magicId, fromAll } = place;
	const setPage = (next: AutomationsPlace["page"]): void => movePlace({ page: next });
	// A right-click action's own page, one step in from the list as a rule's is.
	const setMagicId = (next: string | null): void => movePlace({ magicId: next });
	/** A rule's or a right-click action's page was opened from 전체 기록: its path says so, and a step on it goes straight back there. */
	const setFromAll = (next: boolean): void => movePlace({ fromAll: next });
	const magic = magicActions.find((action) => action.id === magicId) ?? null;
	const magicRuns = useMagicRunHistory(magicActions.map((action) => action.id));
	const [confirmMagic, setConfirmMagic] = useState<MagicAction | null>(null);
	const locations = useLocations();
	const broken = state.configError !== null;
	// A repair of this very error is running: the card gives way to one line saying so, and comes back if the repair did not clear the error.
	const fixing = useErrorFixStore().sessions.find((session) => session.message === state.error && session.run.status === "running");
	const history = useRunHistory(
		[...new Set([...state.rules.map((rule) => rule.id), ...(editing === null ? [] : [editing.id])])],
		state.rules.map((rule) => rule.lastRun?.startedAt ?? 0).join(","),
	);
	// 수정, from anywhere (the list, a menu, the folder inspector, Quick Look), opens the rule's own page.
	const detail = editing;
	const open = (id: string): void => {
		if (id === deletingId) return;
		setPage("list");
		setFromAll(false);
		onEdit(id);
	};
	const toMain = (): void => {
		setPage("list");
		setFromAll(false);
		setMagicId(null);
		onCancelEdit?.();
	};
	const mainCrumb: Crumb = { label: t("places.automations"), action: "automation-back", onClick: toMain };
	const allCrumb: Crumb = { label: t("automations.all.title"), action: "automation-crumb-all", onClick: () => {
		setPage("all");
		setFromAll(false);
		setMagicId(null);
		onCancelEdit?.();
	} };
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		scrollRef.current?.scrollTo?.({ top: 0 });
	}, [detail?.id, page, magicId]);
	// A recommendation is gone once something already does it: a folder rule of its shape, or a right-click action with its task.
	const recommendations = RECOMMENDATIONS.filter((item) =>
		item.trigger === "folder"
			? !templateTaken(state.rules, item.template.id)
			: onCreateMagicAction !== undefined &&
				!magicActions.some((action) => action.execution.kind === "agent" && action.execution.prompt.trim() === t(`automations.templates.${item.template.id}.task` as LocaleKey).trim()),
	);
	/** What a recommendation's card shows and what its 추가하기 writes, for either trigger. */
	const recommendationProps = (item: Recommendation): Omit<Parameters<typeof RecommendationCard>[0], "glow" | "quiet"> => {
		const task = t(`automations.templates.${item.template.id}.task` as LocaleKey);
		if (item.trigger === "rightClick") {
			const target = { selection: item.template.selection, ...rightClickTarget(item.template.clickKind, null) };
			const action = normalizeMagicAction({
				label: t(`automations.templates.${item.template.id}.title` as LocaleKey),
				enabled: true,
				...target,
				execution: { kind: "agent", mode: item.template.mode === "write" ? "organize" : "read", prompt: task },
			});
			return {
				id: item.template.id,
				when: rightClickSentence(t, target),
				task,
				canAdd: action !== null && onCreateMagicAction !== undefined,
				// No count from the person's files: the line says the right-click, which is what is new about it.
				reason: reasons === null ? null : undefined,
				onAdd: async () => (action === null ? false : ((await onCreateMagicAction?.(action)) ?? false)),
			};
		}
		const draft = templateDraft(item.template, locations, task);
		return {
			id: item.template.id,
			when: draft === null ? t(`automations.templates.${item.template.id}.desc` as LocaleKey) : whenText(draftRule(draft)),
			task,
			canAdd: draft !== null,
			reason: reasons === null ? null : reasons[item.template.id],
			onAdd: async () => (draft === null ? false : onCreate(draft)),
		};
	};
	const reasons = useRecommendationReasons(locations);
	const recommendationCards = recommendations.map((item) => <RecommendationCard key={item.template.id} {...recommendationProps(item)} glow={state.rules.length === 0} />);
	return (
		<section data-automations-view className="flex min-h-0 flex-1 flex-col bg-window" aria-label={t("automations.list")}>
			{/* The AI 에이전트 tab's head: only 채팅 | 자동화 at the very middle, the same height as the chat side's and with no line under it. */}
			{/* Laid out at the page's own least width (--pane-min-width), like the chat side's head: a narrower pane cuts the
			    segment on the right with the page under it, never moves it toward the left. */}
			<div className="automations-head flex-none overflow-hidden select-none" data-automations-head>
				<div className="flex h-48 min-w-(--pane-min-width) items-center justify-center">
					<AgentSegment value="automations" onChange={(value) => (value === "chat" ? onShowChat?.() : undefined)} />
				</div>
			</div>
			<div
				ref={scrollRef}
				data-rules-body
				// The scrollbar's room is kept whether or not the page scrolls, so a long page's column sits where a short one's does.
				className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
				onContextMenu={(event) => {
					event.preventDefault();
					onContextMenu(null, { x: event.clientX, y: event.clientY });
				}}
			>
				{/* Narrower than half the workspace with both sidebars open (--pane-min-width), the page is cut on the right instead of squeezed. */}
				{/* The list's top edge is fixed a little way down the pane (about where the first screen looks balanced), so opening a menu or a card
				    only grows it downward and nothing jumps. A page one step in (a rule's or a right-click action's, 전체 기록) is read from the
				    top, as Settings' pages are: it starts 40px down, the same with or without runs. */}
				<div className={cn("flex min-h-full min-w-(--pane-min-width) flex-col px-40 pb-40", detail !== null || magic !== null || page === "all" ? "pt-40" : "pt-[clamp(32px,14vh,140px)]")}>
				<div className="mx-auto flex w-full max-w-[640px] flex-none flex-col gap-24">
					{state.error === null ? null : fixing !== undefined ? (
						<div role="status" data-automation-fixing className="flex h-40 items-center gap-8 rounded-12 border border-border px-14 text-meta text-ink-muted">
							<SparklesIcon size={14} className="flex-none text-accent" />
							<span className="shimmer min-w-0 flex-1 truncate">{t("automations.errors.fixing")}</span>
							<button type="button" className="flex-none border-0 bg-transparent p-0 text-meta text-accent-text cursor-pointer hover:underline" onClick={() => openErrorFixDialog(fixing.id)}>
								{t("automations.errors.fixingView")}
							</button>
						</div>
					) : (
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
					) : !state.ready ? null : magic !== null && detail === null ? (
						<MagicActionDetail
							action={magic}
							runs={magicRuns[magic.id]}
							crumbs={fromAll ? [mainCrumb, allCrumb] : [mainCrumb]}
							onUpdate={async (next) => (await onUpdateMagicAction?.(next)) ?? false}
							onToggle={onToggleMagicAction}
							onDelete={() => setConfirmMagic(magic)}
							onOpenFolder={onOpenFolder}
						/>
					) : detail !== null ? (
						<AutomationDetail
							rule={detail}
							runs={history[detail.id]}
							crumbs={fromAll ? [mainCrumb, allCrumb] : [mainCrumb]}
							onRename={onRename}
							onUpdate={onUpdate}
							onToggle={onToggleRule}
							onDelete={() => {
								// A deleted rule leaves for the main page, not for the 전체 기록 it was opened from.
								setPage("list");
								setFromAll(false);
								onAskDelete(detail.id);
							}}
							onDraftChange={onDraftChange}
							onOpenFolder={onOpenFolder}
						/>
					) : page === "all" ? (
						<AllRunsPage
							entries={[
								...state.rules.flatMap((rule) =>
									(history[rule.id] ?? (rule.lastRun === null ? [] : [rule.lastRun])).map((run) => ({ key: `rule-${rule.id}-${run.startedAt}`, kind: "rule" as const, id: rule.id, name: ruleTitle(rule), run })),
								),
								...magicActions.flatMap((action) =>
									(magicRuns[action.id] ?? []).map((run) => ({ key: `magic-${action.id}-${run.startedAt}`, kind: "magic" as const, id: action.id, name: action.label, run })),
								),
							]}
							onOpen={(entry) => {
								// Either page opens over 전체 기록, which stays where it is behind it and in the page's path.
								if (entry.kind === "magic") {
									setFromAll(true);
									setMagicId(entry.id);
									return;
								}
								// A rule being deleted has no page to open.
								if (entry.id === deletingId) return;
								// The rule's page opens over 전체 기록, which stays where it is behind it.
								setFromAll(true);
								onEdit(entry.id);
							}}
							crumbs={[mainCrumb]}
						/>
					) : state.rules.length === 0 && magicActions.length === 0 ? (
						// With no rules the recommendations are the page: a line on what automations do, what the person's files
						// suggest (glowing: the AI offers them), and a way to ask in words.
						<section className="flex flex-col gap-10" data-automation-recommendations>
							<div className="mb-8 flex flex-col gap-4" data-automation-hero>
								<h2 className="m-0 mt-2 text-[17px] font-bold leading-[24px] text-ink">{t("automations.recs.hero")}</h2>
								<p className="m-0 text-[13px] leading-[19px] text-ink-muted">{t("automations.recs.heroCaption")}</p>
							</div>
							{recommendationCards}
							<p className="m-0 mt-6 flex items-center gap-8 text-meta leading-[18px] text-ink-muted">
								{t("automations.recs.more")}
								<button type="button" data-action="automation-talk" className="border-0 bg-transparent p-0 text-meta text-accent-text cursor-pointer hover:underline" onClick={() => onTalk?.()}>
									{t("automations.recs.talk")}
								</button>
							</p>
						</section>
					) : (
						<>
							<section className="flex flex-col gap-8">
								<div className="flex items-center gap-8">
									<h2 className="m-0 flex-1 text-[14px] font-bold leading-[20px] text-ink">{t("automations.mine")}</h2>
									<button
										type="button"
										data-action="automation-composer-open"
										className="inline-flex h-28 flex-none items-center gap-4 rounded-6 border border-accent bg-accent px-10 text-meta font-medium text-on-accent cursor-pointer hover:border-accent-hover hover:bg-accent-hover"
										onClick={() => onTalk?.()}
									>
										<TabPlusIcon size={13} />
										{t("automations.create.headButton")}
									</button>
								</div>
								{/* One soft shadow on the whole list, not on each row, so it lifts the group the same however many rules there are. */}
								<div role="grid" aria-label={t("automations.list")} className="flex flex-col overflow-hidden rounded-12 border border-border shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.04)] [&>[role=row]+[role=row]]:border-t-[0.5px] [&>[role=row]+[role=row]]:border-divider">
									{state.rules.map((rule) => (
										<RuleRow key={rule.id} rule={rule} deleting={rule.id === deletingId} selected={rule.id === selectedId} onSelect={onSelect} onOpen={open} onToggle={onToggleRule} onContextMenu={onContextMenu} />
									))}
									{/* The right-click actions are automations too, with another trigger: they sit in the same list. */}
									{magicActions.map((action) => (
										<MagicActionRow key={action.id} action={action} onOpen={(id) => {
											setFromAll(false);
											setMagicId(id);
										}} onToggle={onToggleMagicAction} />
									))}
								</div>
								{state.rules.length === 0 && magicActions.length === 0 ? null : (
									<button type="button" data-action="automation-all-runs" className="self-start border-0 bg-transparent p-0 pl-6 text-meta leading-[16px] text-accent-text cursor-pointer hover:underline" onClick={() => setPage("all")}>
										{t("automations.all.open")}
									</button>
								)}
							</section>
							{recommendations.length === 0 ? null : (
								// Under the person's own rules the recommendations are one quiet grouped list: no glow, no stroke.
								<section className="flex flex-col gap-8" data-automation-recommendations>
									<h2 className="m-0 text-meta leading-[16px] text-ink-muted">{t("automations.recs.section")}</h2>
									<div className="flex flex-col overflow-hidden rounded-12 bg-subtle-alt [&>*+*]:border-t-[0.5px] [&>*+*]:border-divider" data-quiet-recommendations>
										{recommendations.map((item) => (
											<RecommendationCard key={item.template.id} quiet {...recommendationProps(item)} />
										))}
									</div>
								</section>
							)}
						</>
					)}
				</div>
				</div>
			</div>
			{confirmMagic === null ? null : (
				<ConfirmDialog
					title={t("settingsCore.contextMenu.removeMagicConfirmTitle", { name: confirmMagic.label })}
					message={t("automations.confirm.magicMessage")}
					confirmLabel={t("automations.confirm.action")}
					cancelLabel={t("common.cancel")}
					danger
					onCancel={() => setConfirmMagic(null)}
					onConfirm={() => {
						const id = confirmMagic.id;
						setConfirmMagic(null);
						// A deleted action leaves for the main page, as a deleted rule does, not for the 전체 기록 it was opened from.
						setPage("list");
						setFromAll(false);
						setMagicId(null);
						void onDeleteMagicAction?.(id);
					}}
				/>
			)}
		</section>
	);
}
