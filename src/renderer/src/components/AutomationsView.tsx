/**
 * The 자동화 tab (Figma 621:4556, 621:4882, 621:5262), one centred column in three places:
 * - 내 자동화: 새 자동화 만들기… opens the card that writes a rule straight to the rules file, 내 자동화 lists every rule
 *   (status dot, name, when it runs, how its last run went, ›), and 추천 자동화 fill the card.
 * - a rule's own page (› on its row): its name, which a click renames in place, the card to change and save it, and
 *   its 실행 기록 read from the rule's run log.
 * - 전체 기록: every rule's runs, newest first, with 실패만 보기.
 * A footer line keeps the background service's state and its switch. It only draws and reports: the rules come from
 * the shared store, and delete asks before it removes anything.
 */

import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AutomationDraft, AutomationEventType, AutomationRule, AutomationRun, AutomationsSnapshot } from "../../../shared/automation-contract";
import type { FsLocation } from "../../../shared/fs-contract";
import type { LocaleKey } from "../../../shared/i18n/core";
import { cn } from "../lib/cn";
import { customRuleName, derivedTitle, failReason, folderLabel, kindsText, relativeTime, ruleTitle, runTone, whatText, whenText, type RunTone } from "../state/automations";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, EyeIcon, FilePenIcon, FolderGlyph, PencilIcon, TabPlusIcon } from "./icons";
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
	/** Right click on a row (`id`) or on the empty space (`null`), at the pointer. */
	readonly onContextMenu: (id: string | null, at: { readonly x: number; readonly y: number }) => void;
	readonly onOpenFolder: (path: string) => void;
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
	testId,
	onChange,
}: {
	readonly value: T | null;
	readonly options: readonly ChipOption<T>[];
	readonly label: string;
	readonly icon?: ReactNode;
	readonly round?: boolean;
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
				className={cn(
					"inline-flex items-center gap-4 px-8 py-4 border-[0.5px] border-divider bg-window text-meta leading-[18px] text-ink whitespace-nowrap cursor-pointer hover:border-border",
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
	onDelete,
	editing,
	filled,
}: {
	readonly onCreate: AutomationsViewProps["onCreate"];
	readonly onUpdate: AutomationsViewProps["onUpdate"];
	readonly onCancelEdit: AutomationsViewProps["onCancelEdit"];
	readonly onDraftChange: AutomationsViewProps["onDraftChange"];
	/** On a rule's own page: 삭제 in place of 취소, and 저장 in place of 수정하기. */
	readonly onDelete?: (() => void) | undefined;
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

	// 수정 on a rule: the card takes the rule in, and 만들기 becomes 수정하기. Leaving a rule empties the card; a card
	// that opens with no rule keeps what a 추천 자동화 row just put in it.
	const editedBefore = useRef<string | null>(null);
	useEffect(() => {
		const before = editedBefore.current;
		editedBefore.current = editing?.id ?? null;
		if (editing === null) {
			if (before !== null) reset();
			return;
		}
		const matchedKind = kindOf(editing.include);
		const matchedEvent = eventOf(editing.events);
		const profile = editing.agent?.profile ?? null;
		setFolder(editing.paths[0] ?? null);
		setKind(matchedKind ?? "all");
		setCustomInclude(matchedKind === null ? editing.include : null);
		setEvent(matchedEvent ?? "create");
		setCustomEvents(matchedEvent === null ? editing.events : null);
		setMode(profile === PROFILES.write ? "write" : "read");
		setCustomProfile(profile !== null && profile !== PROFILES.read && profile !== PROFILES.write ? profile : null);
		setTask(editing.agent?.task ?? whatText(editing, { full: true }));
		setRun(editing.agent === undefined ? editing.run : null);
		setTouched(true);
		// On a rule's own page the card is read first; only the list's card jumps to the instruction.
		if (onDelete === undefined) {
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
	const canSubmit = !busy && draft !== null && task.trim().length > 0;

	useEffect(() => {
		onDraftChange?.(touched && draft !== null ? draftRule(draft) : null);
	}, [touched, JSON.stringify(draft)]);
	useEffect(() => () => onDraftChange?.(null), []);
	const touch = <T,>(set: (value: T) => void, clear?: () => void) => (value: T): void => {
		set(value);
		clear?.();
		setTouched(true);
	};
	const submit = async (): Promise<void> => {
		if (!canSubmit || draft === null) return;
		setBusy(true);
		const ok = editing === null ? await onCreate(draft) : onUpdate === undefined ? false : await onUpdate(editing.id, draft);
		setBusy(false);
		if (ok && editing === null) reset();
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
		<div ref={cardRef} className={cn("flex flex-col gap-8 rounded-[14px] bg-window p-14", editing !== null && onDelete === undefined && "border border-accent")} data-testid="automation-new" data-editing={editing?.id}>
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
				className="h-60 resize-none rounded-10 border-[0.5px] border-divider bg-window px-10 py-8 text-[13px] leading-[20px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
				onChange={(change) => {
					setTask(change.target.value);
					setTouched(true);
					// Typing over a program's words makes it an instruction for the agent.
					setRun(null);
				}}
			/>
			<div className="flex items-center gap-6">
				{run === null ? (
					<ChipSelect value={mode} options={modes} label={t("automations.create.modeLabel")} round testId="automation-new-mode" onChange={touch(setMode, () => setCustomProfile(null))} />
				) : null}
				<span className="flex-1" />
				{editing !== null && onDelete !== undefined ? (
					<button
						type="button"
						data-action="automation-delete"
						className="mr-6 inline-flex h-32 items-center border-0 bg-transparent p-0 text-meta text-ink-muted cursor-pointer hover:text-ink"
						onClick={onDelete}
					>
						{t("automations.inspector.delete")}
					</button>
				) : editing === null ? null : (
					<button
						type="button"
						data-action="automation-cancel-edit"
						className="inline-flex h-32 items-center justify-center rounded-6 border border-border bg-window px-12 text-meta font-medium text-ink-body cursor-pointer hover:opacity-80"
						onClick={() => onCancelEdit?.()}
					>
						{t("common.cancel")}
					</button>
				)}
				<button
					type="button"
					data-action={editing === null ? "automation-create" : "automation-update"}
					disabled={!canSubmit}
					className="inline-flex h-32 items-center justify-center rounded-6 border-0 bg-accent px-12 text-meta font-medium text-on-accent cursor-pointer disabled:cursor-default disabled:opacity-50"
					onClick={() => void submit()}
				>
					{busy ? t("automations.daemon.busy") : editing === null ? t("automations.create.submit") : onDelete !== undefined ? t("common.save") : t("automations.create.submitEdit")}
				</button>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ the list -- */

/** A 내 자동화 row (Figma 621:4556): the run dot, the name over when it runs, how its last run went, and ›, which opens the rule's page. */
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
	const run = rule.lastRun;
	const tone = runTone(run);
	return (
		<div
			ref={ref}
			role="row"
			aria-selected={selected}
			data-rule-id={rule.id}
			className={cn("flex items-center gap-10 py-10 pl-12 pr-10 select-none cursor-pointer", selected ? "bg-accent-soft" : "bg-window hover:bg-hover-row")}
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
			<RunDot tone={tone} />
			<div role="gridcell" className="flex min-w-0 flex-1 flex-col gap-px">
				<span className="truncate text-[13px] font-medium leading-[20px] text-ink">{ruleTitle(rule)}</span>
				<span className="truncate text-meta leading-[16px] text-ink-muted">{whenText(rule)}</span>
			</div>
			<span data-rule-last-run className={cn("flex-none text-meta leading-[16px]", tone === "fail" ? "text-error-orange-text" : "text-ink-muted")}>
				{run === null ? t("automations.inspector.notRun") : `${relativeTime(run.startedAt)} · ${tone === "ok" ? t("automations.detail.ok") : t("automations.detail.failed")}`}
			</span>
			<ChevronRightIcon size={14} className="flex-none text-ink-faint" />
		</div>
	);
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement {
	return (
		<section className="flex flex-col gap-8">
			<h2 className="m-0 text-meta font-medium leading-[16px] text-ink-muted">{title}</h2>
			{children}
		</section>
	);
}

/** 내 자동화 | 전체 기록: the two places the column shows (Figma 621:4556, 621:5262). */
function Segmented<T extends string>({ value, options, onChange }: { readonly value: T; readonly options: readonly { readonly value: T; readonly label: string }[]; readonly onChange: (value: T) => void }): ReactElement {
	return (
		<div role="tablist" className="inline-flex self-start gap-2 rounded-[9px] bg-chrome p-2" data-automation-tabs>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					role="tab"
					aria-selected={option.value === value}
					data-tab={option.value}
					className={cn(
						"h-28 rounded-[7px] border-0 px-14 text-[13px] cursor-pointer",
						option.value === value ? "bg-window font-medium text-ink shadow-[0_0_0_0.5px_var(--border)]" : "bg-transparent text-ink-muted hover:text-ink",
					)}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
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
function RunLine({ run, rule, onOpen }: { readonly run: AutomationRun; readonly rule?: AutomationRule; readonly onOpen?: () => void }): ReactElement {
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
	const row = "flex w-full flex-col items-start gap-6 border-0 bg-window px-14 py-10 text-left";
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

/** A rounded list whose rows are split by hairlines, the box every section of the column uses. */
function ListBox({ children, label }: { readonly children: ReactNode; readonly label?: string }): ReactElement {
	return (
		<div role="list" aria-label={label} className="flex flex-col overflow-hidden rounded-12 border-[0.5px] border-divider [&>*+*]:border-t-[0.5px] [&>*+*]:border-divider">
			{children}
		</div>
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
				className="h-26 min-w-0 flex-1 rounded-6 border border-accent bg-window px-6 text-[13px] font-medium leading-[20px] text-ink outline-none placeholder:font-normal placeholder:text-ink-faint"
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
			className="group inline-flex h-26 min-w-0 items-center gap-6 rounded-6 border-0 bg-transparent px-6 -mx-6 text-left cursor-text hover:bg-hover"
			onClick={start}
		>
			<span className="truncate text-[13px] font-medium leading-[20px] text-ink">{ruleTitle(rule)}</span>
			<PencilIcon size={13} className="flex-none text-ink-faint group-hover:text-ink-muted" />
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
			<div className="flex min-w-0 items-center gap-6">
				<button
					type="button"
					data-action="automation-back"
					className="inline-flex flex-none items-center gap-2 border-0 bg-transparent p-0 text-[13px] text-ink-muted cursor-pointer hover:text-ink"
					onClick={onBack}
				>
					<ChevronLeftIcon size={14} />
					{t("places.automations")}
				</button>
				<span className="flex-none text-[13px] text-ink-faint" aria-hidden="true">/</span>
				<EditableTitle key={rule.id} rule={rule} onRename={onRename} />
			</div>
			<Section title={t("automations.detail.settings")}>
				<NewAutomationCard onCreate={async () => false} onUpdate={onUpdate} onCancelEdit={undefined} onDraftChange={onDraftChange} onDelete={onDelete} editing={rule} filled={null} />
			</Section>
			<Section title={list.length === 0 ? t("automations.detail.history") : `${t("automations.detail.history")} (${list.length})`}>
				{list.length === 0 ? (
					<p className="m-0 rounded-12 border-[0.5px] border-divider bg-window px-14 py-12 text-meta leading-[18px] text-ink-muted">{t("automations.inspector.noRuns")}</p>
				) : (
					<ListBox label={t("automations.detail.history")}>
						{list.map((run) => (
							<RunLine key={`${run.startedAt}-${run.durationMs}`} run={run} />
						))}
					</ListBox>
				)}
			</Section>
		</div>
	);
}

/** 전체 기록 (Figma 621:5262): every rule's runs, newest first; 실패만 보기 keeps the failed ones; a row opens its rule. */
function AllRuns({ rules, history, onOpen }: { readonly rules: readonly AutomationRule[]; readonly history: Readonly<Record<string, readonly AutomationRun[]>>; readonly onOpen: (id: string) => void }): ReactElement {
	const { t } = useTranslation();
	const [failOnly, setFailOnly] = useState(false);
	const all = rules
		.flatMap((rule) => (history[rule.id] ?? (rule.lastRun === null ? [] : [rule.lastRun])).map((run) => ({ rule, run })))
		.sort((a, b) => b.run.startedAt - a.run.startedAt);
	const shown = failOnly ? all.filter(({ run }) => runTone(run) === "fail") : all;
	return (
		<section className="flex flex-col gap-8" data-automation-all-runs>
			<div className="flex items-center gap-8">
				<span className="text-meta leading-[16px] text-ink-muted">{t("automations.all.count", { count: all.length })}</span>
				<span className="flex-1" />
				<span className="text-meta leading-[16px] text-ink-body">{t("automations.all.failOnly")}</span>
				<Switch checked={failOnly} dataSwitchId="automation-fail-only" ariaLabel={t("automations.all.failOnly")} onChange={() => setFailOnly((was) => !was)} />
			</div>
			{shown.length === 0 ? (
				<p className="m-0 rounded-12 border-[0.5px] border-divider bg-window px-14 py-12 text-meta leading-[18px] text-ink-muted">{failOnly ? t("automations.all.noFails") : t("automations.inspector.noRuns")}</p>
			) : (
				<ListBox label={t("automations.tabs.all")}>
					{shown.map(({ rule, run }) => (
						<RunLine key={`${rule.id}-${run.startedAt}`} run={run} rule={rule} onOpen={() => onOpen(rule.id)} />
					))}
				</ListBox>
			)}
		</section>
	);
}

function BackgroundLine({
	state,
	busy,
	onSetDaemon,
}: {
	readonly state: AutomationsSnapshot;
	readonly busy: boolean;
	readonly onSetDaemon: (enabled: boolean) => void;
}): ReactElement {
	const { t } = useTranslation();
	const daemon = state.daemon;
	// A registered service that is not running (crashed, or stopped by the OS) is off for the user's purposes.
	const running = daemon?.running === true;
	return (
		<footer
			data-daemon
			className="pathbar flex h-24 flex-none items-center gap-8 border-t border-border bg-chrome pl-8 pr-12 text-badge text-ink-body"
		>
			{daemon === null ? (
				<span className="inline-flex items-center gap-6 text-ink-muted">
					<StatusDot token="--text-faint" />
					{t("automations.daemon.unknown")}
				</span>
			) : (
				<span className="inline-flex items-center gap-6 text-ink-muted">
					<StatusDot token={running ? "--ok-dot" : "--text-faint"} />
					{running ? t("automations.daemon.on") : t("automations.daemon.off")}
				</span>
			)}
			<span className="text-ink-faint" aria-hidden="true">·</span>
			<span className="text-ink-muted">{t("automations.daemon.count", { count: state.rules.length })}</span>
			<span className="flex-1" />
			{daemon === null ? null : (
				<button
					type="button"
					disabled={busy}
					className="p-0 border-0 bg-transparent text-accent-text text-badge cursor-pointer disabled:text-ink-muted disabled:cursor-default"
					onClick={() => onSetDaemon(!running)}
				>
					{busy ? t("automations.daemon.busy") : running ? t("automations.daemon.turnOff") : t("automations.daemon.turnOn")}
				</button>
			)}
		</footer>
	);
}

export function AutomationsView({ state, daemonBusy, selectedId, onSelect, onEdit, onAskDelete, onRename, onCreate, onUpdate, onCancelEdit, editing = null, onDraftChange, onContextMenu, onSetDaemon }: AutomationsViewProps): ReactElement {
	const { t } = useTranslation();
	const [filled, setFilled] = useState<{ readonly template: Template; readonly at: number } | null>(null);
	const [tab, setTab] = useState<"mine" | "all">("mine");
	const [composerOpen, setComposerOpen] = useState(false);
	const broken = state.configError !== null;
	const history = useRunHistory(
		[...new Set([...state.rules.map((rule) => rule.id), ...(editing === null ? [] : [editing.id])])],
		state.rules.map((rule) => rule.lastRun?.startedAt ?? 0).join(","),
	);
	// 수정, from anywhere (the list, a menu, the folder inspector, Quick Look), opens the rule's own page.
	const detail = editing;
	const open = (id: string): void => onEdit(id);
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		scrollRef.current?.scrollTo?.({ top: 0 });
	}, [detail?.id, tab]);
	return (
		<section data-automations-view className="flex min-h-0 flex-1 flex-col bg-subtle-alt" aria-label={t("automations.list")}>
			<div
				ref={scrollRef}
				data-rules-body
				className="min-h-0 flex-1 overflow-auto px-40 pb-40 pt-56"
				onContextMenu={(event) => {
					event.preventDefault();
					onContextMenu(null, { x: event.clientX, y: event.clientY });
				}}
			>
				<div className="mx-auto flex w-full max-w-[600px] flex-col gap-24">
					{state.error === null ? null : (
						<p role="alert" className="m-0 rounded-8 bg-error-orange-bg px-12 py-8 text-meta text-error-orange-text">
							{state.error}
						</p>
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
					) : (
						<>
							<Segmented
								value={tab}
								options={[
									{ value: "mine", label: t("automations.mine") },
									{ value: "all", label: t("automations.tabs.all") },
								]}
								onChange={setTab}
							/>
							{tab === "all" ? (
								<AllRuns rules={state.rules} history={history} onOpen={open} />
							) : (
								<>
									{composerOpen || state.rules.length === 0 || filled !== null ? (
										<Section title={t("automations.create.title")}>
											{/* The aurora behind the card (tokens.css §8): the place where Dazzi is asked to make something. */}
											<div className="ai-glow-host" data-ai-glow>
												<div className="ai-glow" aria-hidden="true" />
												{state.rules.length === 0 ? null : (
													<button
														type="button"
														data-action="automation-composer-close"
														aria-label={t("common.close")}
														title={t("common.close")}
														className="absolute -top-26 right-0 flex size-20 items-center justify-center rounded-4 border-0 bg-transparent p-0 text-ink-muted cursor-pointer hover:bg-hover hover:text-ink"
														onClick={() => {
															setComposerOpen(false);
															setFilled(null);
														}}
													>
														<CloseIcon size={12} />
													</button>
												)}
												<NewAutomationCard
													onCreate={async (draft) => {
														const ok = await onCreate(draft);
														if (ok) {
															setComposerOpen(false);
															setFilled(null);
														}
														return ok;
													}}
													onUpdate={onUpdate}
													onCancelEdit={onCancelEdit}
													onDraftChange={onDraftChange}
													editing={null}
													filled={filled}
												/>
											</div>
										</Section>
									) : (
										<button
											type="button"
											data-action="automation-composer-open"
											className="flex w-full items-center gap-8 rounded-12 border-[0.5px] border-divider bg-window px-14 py-12 text-left text-[13px] text-ink-muted cursor-pointer hover:bg-hover-row hover:text-ink"
											onClick={() => setComposerOpen(true)}
										>
											<TabPlusIcon size={16} />
											{t("automations.create.open")}
										</button>
									)}
									{state.rules.length === 0 ? null : (
										<Section title={t("automations.mine")}>
											<div role="grid" aria-label={t("automations.list")} className="flex flex-col overflow-hidden rounded-12 border-[0.5px] border-divider [&>[role=row]+[role=row]]:border-t-[0.5px] [&>[role=row]+[role=row]]:border-divider">
												{state.rules.map((rule) => (
													<RuleRow key={rule.id} rule={rule} selected={rule.id === selectedId} onSelect={onSelect} onOpen={open} onContextMenu={onContextMenu} />
												))}
											</div>
										</Section>
									)}
									<Section title={t("automations.templates.title")}>
										{/* Figma 611:4016: the same rounded list as 내 자동화, a title and its sentence per row. */}
										<div className="flex flex-col overflow-hidden rounded-12 border-[0.5px] border-divider [&>button+button]:border-t-[0.5px] [&>button+button]:border-divider">
											{TEMPLATES.map((template) => (
												<button
													key={template.id}
													type="button"
													data-template={template.id}
													className="group flex items-center gap-10 border-0 bg-window px-16 py-10 text-left cursor-pointer hover:bg-hover-row"
													onClick={() => {
														setFilled({ template, at: Date.now() });
														setComposerOpen(true);
													}}
												>
													<span className="flex min-w-0 flex-1 flex-col items-start gap-px">
														<span className="text-[13px] font-medium leading-[20px] text-ink">{t(`automations.templates.${template.id}.title` as LocaleKey)}</span>
														<span className="text-meta leading-[18px] text-ink-muted">{t(`automations.templates.${template.id}.desc` as LocaleKey)}</span>
													</span>
													<span className="flex-none text-meta text-accent-text opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">{t("automations.templates.add")}</span>
												</button>
											))}
										</div>
									</Section>
								</>
							)}
						</>
					)}
				</div>
			</div>
			{state.rules.length === 0 && state.daemon === null ? null : <BackgroundLine state={state} busy={daemonBusy} onSetDaemon={onSetDaemon} />}
		</section>
	);
}
