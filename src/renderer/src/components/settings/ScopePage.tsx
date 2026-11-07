/**
 * Settings → 검색 범위: what the index covers. The search folders, picked in the system dialog (a remote browser has
 * none, and types the path), and the exclusions. Every change is one `configPatch` of the same
 * `searchPaths`/`excludePaths` the CLI and the librarian read; the rules for those changes are in
 * `shared/index-scope-edit.ts`. How much of this is indexed, and where, is the map on Settings → 인덱싱.
 */

import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Folder, FolderPlus } from "lucide-react";
import type { LocaleKey } from "../../../../shared/i18n/core";
import { addSearchRoots, removeSearchRoot, type RejectedReason, type RejectedRoot } from "../../../../shared/index-scope-edit";
import { DEFAULT_CODE_FOLDER_NAMES, type AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import { normalizeTypedPath } from "../../state/paths";
import { Switch } from "../primitives/Switch";
import { Chips, Note, PromptModal, Row, Section, SettingsPageHead } from "./SettingsKit";
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

export function ScopePage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { t } = useTranslation();
	const { run, saving, error } = useConfigWriter(onSaved);
	const [typing, setTyping] = useState<ListKey | null>(null);
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

	async function submitTyped(value: string): Promise<void> {
		const key = typing;
		setTyping(null);
		if (key === "searchPaths") await addFolders([normalizeTypedPath(value, await homeFolder())]);
		else if (key === "excludePaths") await writeList("excludePaths", [...excludePaths, value]);
	}

	const shown = problem ?? error;

	return (
		<>
			<SettingsPageHead title={t("settingsSources.scope.title")} description={t("settingsSources.scope.desc")} />
			{shown !== null ? <div className="settings-error" role="alert">{shown}</div> : null}
			<Section title={t("settingsSources.scope.foldersTitle")} description={t("settingsSources.scope.foldersDesc")}>
				<Row name={t("settingsSources.scope.folderName")} hint={t("settingsSources.scope.folderHint")} stack>
					<div className="settings-path-list">
						{searchPaths.map((path) => (
							<div className="settings-path-line" key={path}>
								<Folder size={14} aria-hidden="true" focusable="false" />
								<span title={path}>{path}</span>
								<button type="button" className="linear-btn settings-btn-quiet" disabled={saving} onClick={() => removeFolder(path)}>{t("common.delete")}</button>
							</div>
						))}
						<button type="button" className="linear-btn settings-btn-quiet" disabled={saving} onClick={() => void addFolder()}>
							<FolderPlus size={13} aria-hidden="true" focusable="false" />{t("settingsSources.scope.addFolder")}
						</button>
					</div>
				</Row>
				{searchPaths.length === 0 ? <Note>{t("settingsSources.scope.emptyFolderNote")}</Note> : null}
			</Section>
			<Section title={t("settingsSources.scope.excludeTitle")} description={t("settingsSources.scope.excludeDesc")}>
				<Note>{t("settingsSources.scope.excludeNote", { folders: codeFolderNames.join(", ") })}</Note>
				<Row name={t("settingsSources.scope.excludeList")} hint={t("settingsSources.scope.excludeListHint")} stack>
					<Chips
						items={excludePaths}
						onRemove={(index) => void writeList("excludePaths", excludePaths.filter((_, i) => i !== index))}
						onAdd={() => setTyping("excludePaths")}
						addLabel={t("settingsSources.scope.addChip")}
					/>
				</Row>
			</Section>
			<Section title={t("settingsSources.scope.fileScopeTitle")}>
				<Row name={t("settingsSources.scope.autoWatch")} hint={fsearch === false ? t("settingsSources.scope.autoWatchHintOff") : t("settingsSources.scope.autoWatchHintOn")}>
					<Switch
						checked={watch}
						disabled={fsearch === false}
						ariaLabel={t("settingsSources.scope.autoWatch")}
						onChange={() => void run([{ path: ["fsearch", "watch"], value: !watch }])}
					/>
				</Row>
			</Section>
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
