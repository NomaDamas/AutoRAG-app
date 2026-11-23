/**
 * The 자동화 tab (Figma 611:3601): a 새 자동화 card that writes a rule straight to the rules file, 내 자동화 as one
 * rounded list (status dot, the rule's name, when it runs), and 추천 자동화 that fill the card. A footer line keeps
 * the background service's state and its switch. It only draws and reports: the rules come from the shared store,
 * editing opens an AI Search draft, and delete asks before it removes anything.
 */

import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationDraft, AutomationEventType, AutomationRule, AutomationsSnapshot } from "../../../shared/automation-contract";
import type { FsLocation } from "../../../shared/fs-contract";
import type { LocaleKey } from "../../../shared/i18n/core";
import { cn } from "../lib/cn";
import { folderLabel, ruleTitle, runTone, whenText, type RunTone } from "../state/automations";
import { CheckIcon, ChevronDownIcon, EyeIcon, FilePenIcon, FileTextIcon, FolderGlyph, ImageIcon, RefreshIcon } from "./icons";
import { StatusDot } from "./primitives/StatusDot";

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

/** The status dot: green after a clean run, orange after a failure, a hollow ring before any run. */
export function RunDot({ tone }: { readonly tone: RunTone }): ReactElement {
	if (tone === "never") {
		return <span data-run-tone={tone} className="flex-none size-dot rounded-full shadow-[inset_0_0_0_1.5px_var(--text-faint)]" aria-hidden="true" />;
	}
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
	readonly icon: ReactNode;
	readonly folder: (typeof FOLDER_ICONS)[number];
	readonly kind: KindId;
	readonly event: EventId;
	readonly mode: ModeId;
	/** A template that runs a program instead of an agent; typing over its instruction makes it an agent rule. */
	readonly run?: readonly string[];
}

const TEMPLATES: readonly Template[] = [
	{ id: "screenshot", icon: <ImageIcon />, folder: "desktop", kind: "image", event: "create", mode: "write" },
	{ id: "pdf", icon: <FileTextIcon />, folder: "downloads", kind: "pdf", event: "create", mode: "write" },
	{ id: "refresh", icon: <RefreshIcon size={14} />, folder: "documents", kind: "all", event: "createUpdate", mode: "read", run: ["autorag", "refresh"] },
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

function NewAutomationCard({ onCreate, filled }: { readonly onCreate: AutomationsViewProps["onCreate"]; readonly filled: { readonly template: Template; readonly at: number } | null }): ReactElement {
	const { t } = useTranslation();
	const [locations, setLocations] = useState<readonly FsLocation[]>([]);
	const [folder, setFolder] = useState<string | null>(null);
	const [kind, setKind] = useState<KindId>("pdf");
	const [event, setEvent] = useState<EventId>("create");
	const [task, setTask] = useState("");
	const [mode, setMode] = useState<ModeId>("read");
	const [run, setRun] = useState<readonly string[] | null>(null);
	const [busy, setBusy] = useState(false);
	const taskRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		let live = true;
		const fs = window.autorag?.fs;
		void fs
			?.locations()
			.then((loaded) => {
				if (live) setLocations(loaded);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, []);
	const folders = standardFolders(locations);
	const pathOf = (kindOfFolder: (typeof FOLDER_ICONS)[number]): string | null => locations.find((location) => location.icon === kindOfFolder && location.available)?.path ?? null;
	// 다운로드 until the person picks another; a folder the OS does not have is never offered.
	const chosenFolder = folder ?? folders[0]?.value ?? null;

	// A 추천 자동화 row fills the card, once per click.
	useEffect(() => {
		if (filled === null) return;
		const { template } = filled;
		setFolder(pathOf(template.folder));
		setKind(template.kind);
		setEvent(template.event);
		setMode(template.mode);
		setTask(t(`automations.templates.${template.id}.task`));
		setRun(template.run ?? null);
		taskRef.current?.focus();
		// The locations are read once; the template is what changes.
	}, [filled]);

	const canCreate = !busy && chosenFolder !== null && task.trim().length > 0;
	const create = async (): Promise<void> => {
		if (!canCreate || chosenFolder === null) return;
		setBusy(true);
		const draft: AutomationDraft = {
			paths: [chosenFolder],
			events: EVENTS[event],
			include: KIND_GLOBS[kind],
			...(run === null ? { agent: { profile: PROFILES[mode], task: task.trim() } } : { run }),
		};
		const ok = await onCreate(draft);
		setBusy(false);
		if (ok) {
			setTask("");
			setRun(null);
		}
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
				onChange={setFolder}
			/>
		),
		kind: <ChipSelect value={kind} options={kinds} label={t("automations.create.kindLabel")} testId="automation-new-kind" onChange={setKind} />,
		event: <ChipSelect value={event} options={events} label={t("automations.create.eventLabel")} testId="automation-new-event" onChange={setEvent} />,
	};
	// The sentence's word order is the language's: the chips sit where its {{folder}}, {{kind}} and {{event}} are.
	const sentence = t("automations.create.sentence", { folder: "\u0000folder\u0000", kind: "\u0000kind\u0000", event: "\u0000event\u0000" }).split("\u0000");

	return (
		<div className="flex flex-col gap-8 rounded-[14px] border-[0.5px] border-divider bg-window p-14" data-testid="automation-new">
			<span className="text-badge font-medium leading-[14px] text-ink-body">{t("automations.create.when")}</span>
			<div className="flex flex-wrap items-center gap-6 rounded-10 bg-chrome px-10 py-8" data-testid="automation-new-when">
				{sentence.map((part, index) =>
					part in chips ? (
						<Fragment key={index}>{chips[part]}</Fragment>
					) : part.trim().length === 0 ? null : (
						<span key={index} className="text-meta leading-[18px] text-ink-muted">{part.trim()}</span>
					),
				)}
			</div>
			<span className="mt-4 text-badge font-medium leading-[14px] text-ink-body">{t("automations.create.task")}</span>
			<textarea
				ref={taskRef}
				data-testid="automation-new-task"
				value={task}
				placeholder={t("automations.create.taskPlaceholder")}
				aria-label={t("automations.create.task")}
				className="h-60 resize-none rounded-10 border-[0.5px] border-divider bg-window px-10 py-8 text-[13px] leading-[20px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
				onChange={(change) => {
					setTask(change.target.value);
					// Typing over a program template's words makes it an instruction for the agent.
					setRun(null);
				}}
			/>
			<div className="flex items-center gap-6">
				{run === null ? <ChipSelect value={mode} options={modes} label={t("automations.create.modeLabel")} round testId="automation-new-mode" onChange={setMode} /> : null}
				<span className="flex-1" />
				<button
					type="button"
					data-action="automation-create"
					disabled={!canCreate}
					className="inline-flex h-32 items-center justify-center rounded-6 border-0 bg-accent px-12 text-meta font-medium text-on-accent cursor-pointer disabled:cursor-default disabled:opacity-50"
					onClick={() => void create()}
				>
					{busy ? t("automations.daemon.busy") : t("automations.create.submit")}
				</button>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ the list -- */

function RuleRow({
	rule,
	selected,
	onSelect,
	onEdit,
	onContextMenu,
}: {
	readonly rule: AutomationRule;
	readonly selected: boolean;
	readonly onSelect: (id: string) => void;
	readonly onEdit: (id: string) => void;
	readonly onContextMenu: AutomationsViewProps["onContextMenu"];
}): ReactElement {
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
			className={cn("flex items-center gap-10 px-12 py-10 select-none cursor-default", selected ? "bg-accent-soft" : "bg-window hover:bg-hover-row")}
			onClick={() => onSelect(rule.id)}
			onDoubleClick={() => onEdit(rule.id)}
			onContextMenu={(event: ReactMouseEvent) => {
				event.preventDefault();
				event.stopPropagation();
				onContextMenu(rule.id, { x: event.clientX, y: event.clientY });
			}}
		>
			<RunDot tone={runTone(rule.lastRun)} />
			<div role="gridcell" className="flex min-w-0 flex-1 flex-col gap-px">
				<span className="truncate text-[13px] font-medium leading-[20px] text-ink">{ruleTitle(rule)}</span>
				<span className="truncate text-meta leading-[16px] text-ink-muted">{whenText(rule)}</span>
			</div>
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

export function AutomationsView({ state, daemonBusy, selectedId, onSelect, onEdit, onCreate, onContextMenu, onSetDaemon }: AutomationsViewProps): ReactElement {
	const { t } = useTranslation();
	const [filled, setFilled] = useState<{ readonly template: Template; readonly at: number } | null>(null);
	const broken = state.configError !== null;
	return (
		<section data-automations-view className="flex min-h-0 flex-1 flex-col bg-window" aria-label={t("automations.list")}>
			<div
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
					) : !state.ready ? null : (
						<>
							<Section title={t("automations.create.title")}>
								<NewAutomationCard onCreate={onCreate} filled={filled} />
							</Section>
							{state.rules.length === 0 ? null : (
								<Section title={t("automations.mine")}>
									<div role="grid" aria-label={t("automations.list")} className="flex flex-col overflow-hidden rounded-12 border-[0.5px] border-divider [&>[role=row]+[role=row]]:border-t-[0.5px] [&>[role=row]+[role=row]]:border-divider">
										{state.rules.map((rule) => (
											<RuleRow key={rule.id} rule={rule} selected={rule.id === selectedId} onSelect={onSelect} onEdit={onEdit} onContextMenu={onContextMenu} />
										))}
									</div>
								</Section>
							)}
							<Section title={t("automations.templates.title")}>
								<div className="flex flex-col [&>button+button]:border-t-[0.5px] [&>button+button]:border-divider">
									{TEMPLATES.map((template) => (
										<button
											key={template.id}
											type="button"
											data-template={template.id}
											className="flex flex-col items-start gap-px border-0 bg-transparent px-10 py-9 text-left cursor-pointer rounded-6 hover:bg-hover"
											onClick={() => setFilled({ template, at: Date.now() })}
										>
											<span className="flex items-center gap-6 text-ink">
												{template.icon}
												<span className="text-[13px] font-medium leading-[20px]">{t(`automations.templates.${template.id}.title` as LocaleKey)}</span>
											</span>
											<span className="text-meta leading-[18px] text-ink-muted">{t(`automations.templates.${template.id}.desc` as LocaleKey)}</span>
										</button>
									))}
								</div>
							</Section>
						</>
					)}
				</div>
			</div>
			{state.rules.length === 0 && state.daemon === null ? null : <BackgroundLine state={state} busy={daemonBusy} onSetDaemon={onSetDaemon} />}
		</section>
	);
}
