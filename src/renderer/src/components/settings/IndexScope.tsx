/**
 * What the index covers, as Settings → 인덱싱 shows it (Figma 532:9970; it used to be its own 검색 범위 page). The
 * search folders, picked in the system dialog (a remote browser has none, and types the path), and the exclusions,
 * added through 제외 추가's menu: the system chooser for folders and files, or a typed path. Every change is one
 * `configPatch` of the same `searchPaths`/`excludePaths` the CLI and the librarian read; the rules for those changes
 * are in `shared/index-scope-edit.ts`.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChartPie, ChevronDown, File as FileGlyph, Folder, Plus, X } from "lucide-react";
import type { LocaleKey } from "../../../../shared/i18n/core";
import { addSearchRoots, removeSearchRoot, type RejectedReason, type RejectedRoot } from "../../../../shared/index-scope-edit";
import type { PickPathKind } from "../../../../shared/onboarding-contract";
import { DEFAULT_CODE_FOLDER_NAMES, type AutoRagConfigSnapshot, type AutoRagConfigUpdate } from "../../../../shared/settings-contract";
import { normalizeTypedPath } from "../../state/paths";
import { Switch } from "../primitives/Switch";
import { PromptModal } from "./SettingsKit";
import { asRecord, boolOf, errorText, getAt, listOf, listUpdate } from "./configSupport";
import { cn } from "../../lib/cn";
import { buttonClass } from "../primitives/button";
import type { MapScope } from "./index-map/IndexMapPanel";

type ListKey = "searchPaths" | "excludePaths";

const REJECTED_LABEL: Readonly<Record<RejectedReason, LocaleKey>> = {
	duplicate: "settingsSources.scope.notAdded.duplicate",
	"inside-target": "settingsSources.scope.notAdded.insideTarget",
	"not-absolute": "settingsSources.scope.notAdded.notAbsolute",
};

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/** The user's home folder, to expand `~` in a typed path; null when the bridge does not say. */
async function homeFolder(): Promise<string | null> {
	const locations = await window.autorag?.fs?.locations().catch(() => []);
	return locations?.find((location) => location.section === "favorites" && location.icon === "home")?.path ?? null;
}

/** An exclusion that names a file (its last part has an extension) rather than a folder or a bare name. */
function looksLikeFile(entry: string): boolean {
	const last = entry.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
	return /\.[^.\s]{1,8}$/.test(last) && !last.startsWith(".");
}

/** One choice of 제외 추가's menu. */
interface ExcludeChoice {
	readonly id: string;
	readonly label: LocaleKey;
	readonly pick: PickPathKind | "type";
}

/**
 * macOS shows files and folders in one chooser; Windows and Linux cannot, so they get one entry per kind. A remote
 * browser has no chooser at all and only types the path.
 */
function excludeChoices(remote: boolean): readonly ExcludeChoice[] {
	const typed: ExcludeChoice = { id: "type", label: "settingsSources.scope.excludeType", pick: "type" };
	if (remote) return [typed];
	return [{ id: "pick", label: "settingsSources.scope.excludePick", pick: "any" }, typed];
}

export interface ScopeEditor {
	readonly searchPaths: readonly string[];
	readonly excludePaths: readonly string[];
	readonly saving: boolean;
	/** What the last action could not do (a folder refused, the dialog failing); the writer reports its own failures. */
	readonly problem: string | null;
	readonly addFolder: () => Promise<void>;
	readonly removeFolder: (path: string) => void;
	readonly chooseExclusion: (choice: ExcludeChoice) => Promise<void>;
	readonly removeExclusion: (index: number) => void;
	/** The path prompt, while a path is being typed; render it once, anywhere on the page. */
	readonly prompt: ReactElement | null;
}

/** The folder and exclusion edits, written through the page's own config writer. */
export function useScopeEditor({ snapshot, run, saving }: { readonly snapshot: AutoRagConfigSnapshot; readonly run: (ops: readonly AutoRagConfigUpdate[]) => Promise<void>; readonly saving: boolean }): ScopeEditor {
	const { t } = useTranslation();
	const [typing, setTyping] = useState<ListKey | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const searchPaths = listOf(getAt(snapshot.config, ["searchPaths"]));
	const excludePaths = listOf(getAt(snapshot.config, ["excludePaths"]));
	const remote = window.autoragIsRemote === true;

	const rejection = (rejected: RejectedRoot): string => t(REJECTED_LABEL[rejected.reason], { path: rejected.path });

	function writeList(key: ListKey, next: readonly string[]): Promise<void> {
		setProblem(null);
		return run([listUpdate(key, next)]);
	}

	async function addFolders(paths: readonly string[]): Promise<void> {
		const result = addSearchRoots({ searchPaths, excludePaths }, paths);
		setProblem(result.rejected.length === 0 ? null : result.rejected.map(rejection).join(" "));
		if (!sameList(result.searchPaths, searchPaths)) await run([listUpdate("searchPaths", result.searchPaths)]);
	}

	async function addFolder(): Promise<void> {
		setProblem(null);
		if (remote) {
			setTyping("searchPaths");
			return;
		}
		try {
			const picked = await window.autorag.onboarding.pickFolders();
			await addFolders(picked.map((candidate) => candidate.path));
		} catch (cause) {
			setProblem(errorText(cause));
		}
	}

	function removeFolder(path: string): void {
		setProblem(null);
		const next = removeSearchRoot({ searchPaths, excludePaths }, path);
		const ops = [listUpdate("searchPaths", next.searchPaths)];
		// The exclusions that only meant something under that folder go with it, in the same write.
		if (!sameList(next.excludePaths, excludePaths)) ops.push(listUpdate("excludePaths", next.excludePaths));
		void run(ops);
	}

	async function addExclusions(paths: readonly string[]): Promise<void> {
		const fresh = paths.filter((path, index) => path.trim().length > 0 && !excludePaths.includes(path) && paths.indexOf(path) === index);
		if (fresh.length > 0) await writeList("excludePaths", [...excludePaths, ...fresh]);
	}

	async function chooseExclusion(choice: ExcludeChoice): Promise<void> {
		setProblem(null);
		const pick = window.autorag?.onboarding?.pickPaths;
		if (choice.pick === "type" || pick === undefined) {
			setTyping("excludePaths");
			return;
		}
		try {
			await addExclusions(await pick(choice.pick));
		} catch (cause) {
			setProblem(errorText(cause));
		}
	}

	async function submitTyped(value: string): Promise<void> {
		const key = typing;
		setTyping(null);
		if (key === "searchPaths") await addFolders([normalizeTypedPath(value, await homeFolder())]);
		else if (key === "excludePaths") await addExclusions([value.trim()]);
	}

	const prompt =
		typing === null ? null : (
			<PromptModal
				title={typing === "searchPaths" ? t("settingsSources.scope.addFolderTitle") : t("settingsSources.scope.addItemTitle")}
				description={typing === "searchPaths" ? t("settingsSources.scope.addFolderDesc") : t("settingsSources.scope.addItemDesc")}
				label={typing === "searchPaths" ? t("settingsSources.scope.folderPath") : t("settingsSources.scope.item")}
				placeholder={typing === "searchPaths" ? t("settingsSources.scope.addFolderPlaceholder") : t("settingsSources.scope.addItemPlaceholder")}
				confirmLabel={t("settingsSources.scope.confirmAdd")}
				onCancel={() => setTyping(null)}
				onSubmit={(value) => void submitTyped(value)}
			/>
		);

	return {
		searchPaths,
		excludePaths,
		saving,
		problem,
		addFolder,
		removeFolder,
		chooseExclusion,
		removeExclusion: (index) => void writeList("excludePaths", excludePaths.filter((_, i) => i !== index)),
		prompt,
	};
}

/** A titled block with its button at the right, as on the redesigned settings pages (Figma 386:9908). */
function SectionHead({ title, desc, children }: { readonly title: string; readonly desc: string; readonly children?: ReactElement }): ReactElement {
	return (
		<div className="scope-section-head">
			<div className="scope-section-text">
				<h3 className="scope-section-title">{title}</h3>
				<p className="scope-section-desc">{desc}</p>
			</div>
			{children}
		</div>
	);
}

function PathRow({ path, file, disabled, onRemove }: { readonly path: string; readonly file: boolean; readonly disabled: boolean; readonly onRemove: () => void }): ReactElement {
	const { t } = useTranslation();
	const Icon = file ? FileGlyph : Folder;
	return (
		<div className="scope-row">
			<Icon size={16} strokeWidth={1.6} aria-hidden="true" focusable="false" className="scope-row-icon" />
			<span className="scope-row-path" title={path}>{path}</span>
			<button type="button" className="scope-row-remove" disabled={disabled} aria-label={t("common.delete")} title={t("common.delete")} onClick={onRemove}>
				<X size={14} strokeWidth={1.8} aria-hidden="true" focusable="false" />
			</button>
		</div>
	);
}

/** A folder's share of its files that is read, as a bar, a percentage and the counts; a dash before the map is read. */
/** A folder's progress as a bar and its percent: the file counts are in 진행 상황's banner and under the folder picked in the map. */
function Progress({ counts }: { readonly counts: { readonly indexed: number; readonly targets: number } | null }): ReactElement {
	const { i18n } = useTranslation();
	const number = new Intl.NumberFormat(i18n.language);
	const percentage = counts === null || counts.targets === 0 ? null : Math.min(counts.indexed === counts.targets ? 100 : 99, Math.round((counts.indexed * 100) / counts.targets));
	return (
		<>
			<span className="scope-row-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage ?? undefined}>
				<i style={{ width: `${percentage ?? 0}%` }} />
			</span>
			<span className="scope-row-percent">{percentage === null ? "—" : `${number.format(percentage)}%`}</span>
		</>
	);
}

/**
 * 검색할 폴더: 전체 and each search folder with how much of it is read. Picking one shows it in the map below; 전체
 * shows them all. The × takes a folder out of the search folders.
 */
export function SearchFoldersSection({ editor, scope }: { readonly editor: ScopeEditor; readonly scope: MapScope }): ReactElement {
	const { t } = useTranslation();
	const pick = (path: string | null) => ({
		role: "button" as const,
		tabIndex: 0,
		onClick: () => scope.select(path),
		onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
			if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
				event.preventDefault();
				scope.select(path);
			}
		},
	});
	return (
		<section className="scope-section" data-index-scope="folders">
			<SectionHead title={t("settingsSources.scope.foldersTitle")} desc={t("settingsSources.scope.foldersDesc")}>
				<button type="button" className={cn("scope-primary-btn", buttonClass({ size: "md" }))} disabled={editor.saving} onClick={() => void editor.addFolder()}>
					<Plus size={14} strokeWidth={2} aria-hidden="true" focusable="false" />
					{t("settingsSources.scope.addFolder")}
				</button>
			</SectionHead>
			{editor.searchPaths.length === 0 ? (
				<p className="scope-empty">{t("settingsSources.scope.emptyFolderNote")}</p>
			) : (
				<div className="scope-list scope-list--folders">
					<div className={cn("scope-row is-total is-pickable", scope.selected === null && "is-selected")} data-scope-root="" aria-pressed={scope.selected === null} {...pick(null)}>
						<ChartPie size={16} strokeWidth={1.6} aria-hidden="true" focusable="false" className="scope-row-icon is-accent" />
						<span className="scope-row-name">{t("settingsSources.scope.allFolders")}</span>
						<Progress counts={scope.totals} />
						<span className="scope-row-remove-space" />
					</div>
					{editor.searchPaths.map((path) => (
						<div key={path} className={cn("scope-row is-pickable", scope.selected === path && "is-selected")} data-scope-root={path} aria-pressed={scope.selected === path} {...pick(path)}>
							<Folder size={16} strokeWidth={1.6} aria-hidden="true" focusable="false" className="scope-row-icon" />
							<span className="scope-row-path" title={path}>{path}</span>
							<Progress counts={scope.counts(path)} />
							<button
								type="button"
								className="scope-row-remove"
								disabled={editor.saving}
								aria-label={t("common.delete")}
								title={t("common.delete")}
								onClick={(event) => {
									event.stopPropagation();
									editor.removeFolder(path);
								}}
							>
								<X size={14} strokeWidth={1.8} aria-hidden="true" focusable="false" />
							</button>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

/** 제외 추가: a button whose menu chooses how the exclusion is given. */
function AddExclusionMenu({ choices, disabled, onChoose }: { readonly choices: readonly ExcludeChoice[]; readonly disabled: boolean; readonly onChoose: (choice: ExcludeChoice) => void }): ReactElement {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent): void => {
			if (event.target instanceof Node && rootRef.current?.contains(event.target) !== true) setOpen(false);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);
	return (
		<div className="scope-menu-anchor" ref={rootRef}>
			<button type="button" className={cn("scope-primary-btn scope-secondary-btn", buttonClass({ size: "md" }))} disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<Plus size={14} strokeWidth={2} aria-hidden="true" focusable="false" />
				{t("settingsSources.scope.addExclusion")}
				<ChevronDown size={14} strokeWidth={2} aria-hidden="true" focusable="false" />
			</button>
			{open ? (
				<div className="scope-menu" role="menu">
					{choices.map((choice) => (
						<button
							key={choice.id}
							type="button"
							role="menuitem"
							className="scope-menu-item"
							onClick={() => {
								setOpen(false);
								onChoose(choice);
							}}
						>
							{t(choice.label)}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

/** 제외한 항목: the exclusions, wherever they were left out (the map's 제외 lands here too), and the automatic ones. */
export function ExclusionsSection({ editor, snapshot }: { readonly editor: ScopeEditor; readonly snapshot: AutoRagConfigSnapshot }): ReactElement {
	const { t } = useTranslation();
	const [devOpen, setDevOpen] = useState(false);
	const appIndexing = asRecord(getAt(snapshot.config, ["appIndexing"])) ?? {};
	const storedCodeFolders = listOf(appIndexing.codeFolderNames);
	const codeFolderNames = (storedCodeFolders.length > 0 ? storedCodeFolders : DEFAULT_CODE_FOLDER_NAMES).filter((name) => !name.startsWith("."));
	return (
		<section className="scope-section" data-index-scope="exclusions">
			<SectionHead title={t("settingsSources.scope.excludeTitle")} desc={t("settingsSources.scope.excludeDesc")}>
				<AddExclusionMenu choices={excludeChoices(window.autoragIsRemote === true)} disabled={editor.saving} onChoose={(choice) => void editor.chooseExclusion(choice)} />
			</SectionHead>
			{editor.excludePaths.length === 0 ? null : (
				<div className="scope-list is-scroll">
					{editor.excludePaths.map((path, index) => (
						<PathRow key={`${path}:${index}`} path={path} file={looksLikeFile(path)} disabled={editor.saving} onRemove={() => editor.removeExclusion(index)} />
					))}
				</div>
			)}
			<div className={devOpen ? "scope-dev is-open" : "scope-dev"}>
				<div className="scope-dev-head">
					<span className="scope-dev-title">{t("settingsSources.scope.devExcluded")}</span>
					<button type="button" className="scope-link" aria-expanded={devOpen} onClick={() => setDevOpen((value) => !value)}>
						{devOpen ? t("settingsSources.scope.devLess") : t("settingsSources.scope.devMore")}
					</button>
				</div>
				{devOpen ? (
					<div className="scope-dev-body">
						<span className="scope-dev-names">{codeFolderNames.join(", ")}</span>
						<span className="scope-dev-dots">{t("settingsSources.scope.devDotNote")}</span>
					</div>
				) : null}
			</div>
		</section>
	);
}

/** 파일 이름 바로 반영 (`fsearch.watch`): keeps the name search current as files change; it does not read their contents. */
export function FileNameWatchRow({ snapshot, run }: { readonly snapshot: AutoRagConfigSnapshot; readonly run: (ops: readonly AutoRagConfigUpdate[]) => Promise<void> }): ReactElement {
	const { t } = useTranslation();
	const fsearch = getAt(snapshot.config, ["fsearch"]);
	const watch = boolOf(getAt(snapshot.config, ["fsearch", "watch"])) ?? true;
	return (
		<section className="scope-section scope-section--row scope-section--setting" data-index-scope="watch">
			<div className="scope-section-text">
				<h3 className="scope-section-title">{t("settingsSources.scope.autoWatch")}</h3>
				<p className="scope-section-desc">{fsearch === false ? t("settingsSources.scope.autoWatchHintOff") : t("settingsSources.scope.autoWatchHintOn")}</p>
			</div>
			<Switch checked={watch} disabled={fsearch === false} ariaLabel={t("settingsSources.scope.autoWatch")} onChange={() => void run([{ path: ["fsearch", "watch"], value: !watch }])} />
		</section>
	);
}
