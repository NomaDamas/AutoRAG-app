/**
 * Settings → 검색 범위: what the index covers (Figma 353:4465, 386:9908). The search folders, picked in the system
 * dialog (a remote browser has none, and types the path), and the exclusions, added through 제외 추가's menu: the
 * system chooser for folders and files, or a typed path. Every change is one `configPatch` of the same
 * `searchPaths`/`excludePaths` the CLI and the librarian read; the rules for those changes are in
 * `shared/index-scope-edit.ts`. How much of this is indexed, and where, is the map on Settings → 인덱싱.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, File as FileGlyph, Folder, Plus, X } from "lucide-react";
import type { LocaleKey } from "../../../../shared/i18n/core";
import { addSearchRoots, removeSearchRoot, type RejectedReason, type RejectedRoot } from "../../../../shared/index-scope-edit";
import type { PickPathKind } from "../../../../shared/onboarding-contract";
import { DEFAULT_CODE_FOLDER_NAMES, type AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import { hostPlatform } from "../../lib/shortcuts";
import { normalizeTypedPath } from "../../state/paths";
import { Switch } from "../primitives/Switch";
import { PromptModal, SettingsPageHead } from "./SettingsKit";
import { asRecord, boolOf, errorText, getAt, listOf, listUpdate, useConfigWriter } from "./configSupport";

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
	if (hostPlatform() === "darwin") return [{ id: "pick", label: "settingsSources.scope.excludePick", pick: "any" }, typed];
	return [
		{ id: "folder", label: "settingsSources.scope.excludePickFolder", pick: "folder" },
		{ id: "file", label: "settingsSources.scope.excludePickFile", pick: "file" },
		typed,
	];
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

/** 제외 추가: a primary button whose menu chooses how the exclusion is given. */
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
			<button type="button" className="scope-primary-btn" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
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

export function ScopePage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { t } = useTranslation();
	const { run, saving, error } = useConfigWriter(onSaved);
	const [typing, setTyping] = useState<ListKey | null>(null);
	const [devOpen, setDevOpen] = useState(false);
	/** What the last action could not do (a folder refused, the dialog failing); the writer reports its own failures. */
	const [problem, setProblem] = useState<string | null>(null);
	const searchPaths = listOf(getAt(snapshot.config, ["searchPaths"]));
	const excludePaths = listOf(getAt(snapshot.config, ["excludePaths"]));
	const fsearch = getAt(snapshot.config, ["fsearch"]);
	const watch = boolOf(getAt(snapshot.config, ["fsearch", "watch"])) ?? true;
	const appIndexing = asRecord(getAt(snapshot.config, ["appIndexing"])) ?? {};
	const storedCodeFolders = listOf(appIndexing.codeFolderNames);
	const codeFolderNames = (storedCodeFolders.length > 0 ? storedCodeFolders : DEFAULT_CODE_FOLDER_NAMES).filter((name) => !name.startsWith("."));
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

	const shown = problem ?? error;

	return (
		<>
			<SettingsPageHead title={t("settingsSources.scope.title")} description={t("settingsSources.scope.desc")} />
			{shown !== null ? <div className="settings-error" role="alert">{shown}</div> : null}
			<div className="scope-page">
				<section className="scope-section">
					<div className="scope-section-head">
						<div className="scope-section-text">
							<h3 className="scope-section-title">{t("settingsSources.scope.foldersTitle")}</h3>
							<p className="scope-section-desc">{t("settingsSources.scope.foldersDesc")}</p>
						</div>
						<button type="button" className="scope-primary-btn" disabled={saving} onClick={() => void addFolder()}>
							<Plus size={14} strokeWidth={2} aria-hidden="true" focusable="false" />
							{t("settingsSources.scope.addFolder")}
						</button>
					</div>
					{searchPaths.length === 0 ? (
						<p className="scope-empty">{t("settingsSources.scope.emptyFolderNote")}</p>
					) : (
						<div className="scope-list">
							{searchPaths.map((path) => (
								<PathRow key={path} path={path} file={false} disabled={saving} onRemove={() => removeFolder(path)} />
							))}
						</div>
					)}
				</section>
				<hr className="scope-divider" />
				<section className="scope-section">
					<div className="scope-section-head">
						<div className="scope-section-text">
							<h3 className="scope-section-title">{t("settingsSources.scope.excludeTitle")}</h3>
							<p className="scope-section-desc">{t("settingsSources.scope.excludeDesc")}</p>
						</div>
						<AddExclusionMenu choices={excludeChoices(remote)} disabled={saving} onChoose={(choice) => void chooseExclusion(choice)} />
					</div>
					{excludePaths.length === 0 ? null : (
						<>
							<div className="scope-subtitle">{t("settingsSources.scope.customExcludes")}</div>
							<div className="scope-list">
								{excludePaths.map((path, index) => (
									<PathRow
										key={`${path}:${index}`}
										path={path}
										file={looksLikeFile(path)}
										disabled={saving}
										onRemove={() => void writeList("excludePaths", excludePaths.filter((_, i) => i !== index))}
									/>
								))}
							</div>
						</>
					)}
					<div className="scope-dev">
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
				<hr className="scope-divider" />
				<section className="scope-section scope-section--row">
					<div className="scope-section-text">
						<h3 className="scope-section-title">{t("settingsSources.scope.autoWatch")}</h3>
						<p className="scope-section-desc">{fsearch === false ? t("settingsSources.scope.autoWatchHintOff") : t("settingsSources.scope.autoWatchHintOn")}</p>
					</div>
					<Switch
						checked={watch}
						disabled={fsearch === false}
						ariaLabel={t("settingsSources.scope.autoWatch")}
						onChange={() => void run([{ path: ["fsearch", "watch"], value: !watch }])}
					/>
				</section>
			</div>
			{typing !== null ? (
				<PromptModal
					title={typing === "searchPaths" ? t("settingsSources.scope.addFolderTitle") : t("settingsSources.scope.addItemTitle")}
					description={typing === "searchPaths" ? t("settingsSources.scope.addFolderDesc") : t("settingsSources.scope.addItemDesc")}
					label={typing === "searchPaths" ? t("settingsSources.scope.folderPath") : t("settingsSources.scope.item")}
					placeholder={typing === "searchPaths" ? t("settingsSources.scope.addFolderPlaceholder") : t("settingsSources.scope.addItemPlaceholder")}
					confirmLabel={t("settingsSources.scope.confirmAdd")}
					onCancel={() => setTyping(null)}
					onSubmit={(value) => void submitTyped(value)}
				/>
			) : null}
		</>
	);
}
