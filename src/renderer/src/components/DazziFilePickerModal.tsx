import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, Check, FileText, Folder, HardDrive, Loader2, Search, X } from "lucide-react";
import { previewStreamUrl } from "../../../preview/shared/contract";
import type { FsEntry, FsLocation } from "../../../shared/fs-contract";
import { cn } from "../lib/cn";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

function parentDirectoryOf(filePath: string): string {
	const trimmed = filePath.replace(/[\\/]+$/, "");
	const sepIdx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (sepIdx <= 0) return trimmed.startsWith("/") ? "/" : trimmed;
	return trimmed.slice(0, sepIdx);
}

function directoryLabel(dirPath: string): string {
	const trimmed = dirPath.replace(/[\\/]+$/, "");
	if (trimmed === "" || trimmed === "/") return "/";
	const sepIdx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return sepIdx >= 0 ? trimmed.slice(sepIdx + 1) : trimmed;
}

/**
 * Loads a local image path through Dazzi's `autorag-preview://` stream protocol
 * and converts it into a bounded crisp PNG data URL for `pdf-lib` embedding.
 * Never opens a native OS Finder file picker.
 */
export async function loadLocalImageAsPngDataUrl(
	filePath: string,
	maxDim = 1600,
): Promise<{ readonly dataUrl: string; readonly aspect: number }> {
	const response = await fetch(previewStreamUrl(filePath));
	if (!response.ok) throw new Error(`Could not read image (${response.status}).`);
	const blob = await response.blob();
	const objectUrl = URL.createObjectURL(blob);
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("Could not decode image."));
			el.src = objectUrl;
		});
		const natW = Math.max(1, img.naturalWidth);
		const natH = Math.max(1, img.naturalHeight);
		const scale = Math.min(1, maxDim / Math.max(natW, natH));
		const w = Math.max(1, Math.round(natW * scale));
		const h = Math.max(1, Math.round(natH * scale));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
		return { dataUrl: canvas.toDataURL("image/png"), aspect: w / Math.max(1, h) };
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

export interface DazziFilePickerModalProps {
	readonly mode: "image" | "pdf";
	readonly initialDir: string;
	/** Optional path to exclude from selectable results (e.g. the currently open PDF). */
	readonly excludePath?: string;
	readonly multiple?: boolean;
	readonly onPick: (paths: readonly string[]) => void;
	readonly onClose: () => void;
}

/**
 * In-app Dazzi file picker powered by `window.autorag.fs`.
 * Replaces OS native Finder dialogs when inserting images, signature files, or
 * selecting sibling PDFs to merge.
 */
export function DazziFilePickerModal({
	mode,
	initialDir,
	excludePath,
	multiple = false,
	onPick,
	onClose,
}: DazziFilePickerModalProps): ReactElement {
	const { t } = useTranslation();
	const fsApi = window.autorag?.fs;

	const [locations, setLocations] = useState<readonly FsLocation[]>([]);
	const [currentDir, setCurrentDir] = useState(initialDir);
	const [entries, setEntries] = useState<readonly FsEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<readonly string[]>([]);

	useEffect(() => {
		if (fsApi?.locations === undefined) return;
		let cancelled = false;
		void fsApi
			.locations()
			.then((list) => {
				if (!cancelled) {
					const seen = new Set<string>([initialDir]);
					const deduped: FsLocation[] = [];
					for (const loc of list) {
						if (!loc.available || loc.path === "Recents" || loc.section === "connections") continue;
						if (seen.has(loc.path)) continue;
						seen.add(loc.path);
						deduped.push(loc);
					}
					setLocations(deduped);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [fsApi, initialDir]);

	const loadDir = useCallback(
		async (dirPath: string) => {
			if (fsApi?.listDir === undefined) {
				setLoading(false);
				return;
			}
			setLoading(true);
			setError(null);
			try {
				const listing = await fsApi.listDir(dirPath);
				setCurrentDir(listing.path);
				setEntries(listing.entries);
			} catch (err: unknown) {
				setError(err instanceof Error ? err.message : String(err));
				setEntries([]);
			} finally {
				setLoading(false);
			}
		},
		[fsApi],
	);

	useEffect(() => {
		void loadDir(initialDir);
	}, [initialDir, loadDir]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const visibleEntries = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const folders: FsEntry[] = [];
		const files: FsEntry[] = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (excludePath !== undefined && entry.path === excludePath) continue;
			if (needle !== "" && !entry.name.toLowerCase().includes(needle)) continue;
			if (entry.kind === "folder") {
				folders.push(entry);
				continue;
			}
			const ext = entry.ext.toLowerCase();
			if (mode === "image" ? IMAGE_EXTENSIONS.has(ext) : ext === "pdf") {
				files.push(entry);
			}
		}
		folders.sort((a, b) => a.name.localeCompare(b.name));
		files.sort((a, b) => a.name.localeCompare(b.name));
		return { folders, files };
	}, [entries, excludePath, mode, query]);

	const toggleSelect = (path: string): void => {
		if (!multiple) {
			setSelected([path]);
			return;
		}
		setSelected((curr) => (curr.includes(path) ? curr.filter((p) => p !== path) : [...curr, path]));
	};

	const parentDir = parentDirectoryOf(currentDir);
	const canGoUp = parentDir !== currentDir;
	const title = mode === "image" ? t("documentEditor.pdf.pickerImageTitle") : t("documentEditor.pdf.pickerPdfTitle");
	const confirmLabel =
		mode === "image"
			? t("documentEditor.pdf.pickerInsert")
			: t("documentEditor.pdf.pickerMergeCount", { count: Math.max(1, selected.length) });

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-xs"
			role="dialog"
			aria-modal="true"
			aria-label={title}
			data-dazzi-file-picker={mode}
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="flex h-[520px] max-h-[82vh] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-12 border border-border bg-window shadow-xl">
				{/* Modal Header */}
				<div className="flex h-44 flex-none items-center justify-between gap-12 border-b border-divider bg-chrome px-16">
					<h3 className="m-0 text-body font-semibold text-ink">{title}</h3>
					<button
						type="button"
						aria-label={t("common.close")}
						className="flex size-24 items-center justify-center rounded-6 border-0 bg-transparent text-ink-muted hover:bg-hover hover:text-ink"
						onClick={onClose}
					>
						<X size={15} />
					</button>
				</div>

				{/* Sub-bar: Parent button + current folder path + inline filter */}
				<div className="flex h-36 flex-none items-center gap-8 border-b border-divider bg-window px-12">
					<button
						type="button"
						disabled={!canGoUp}
						title={t("documentEditor.pdf.pickerParentFolder")}
						aria-label={t("documentEditor.pdf.pickerParentFolder")}
						className="flex size-24 items-center justify-center rounded-6 border-0 bg-transparent text-ink-body hover:bg-hover disabled:opacity-30"
						onClick={() => void loadDir(parentDir)}
					>
						<ArrowUp size={14} />
					</button>
					<span className="min-w-0 flex-1 truncate font-mono text-meta text-ink-muted" title={currentDir}>
						{currentDir}
					</span>
					<div className="relative flex w-180 items-center">
						<Search size={13} className="pointer-events-none absolute left-8 text-ink-muted" />
						<input
							type="text"
							value={query}
							data-dazzi-picker-filter="true"
							placeholder={t("documentEditor.pdf.pickerSearchPlaceholder")}
							className="h-24 w-full rounded-6 border border-border bg-input pr-8 pl-26 text-meta text-ink outline-none focus:border-accent"
							onChange={(e) => setQuery(e.target.value)}
						/>
					</div>
				</div>

				{/* Body: Places sidebar + folder/file browser */}
				<div className="flex min-h-0 flex-1 overflow-hidden">
					{/* Places sidebar */}
					<nav className="flex w-[164px] flex-none flex-col gap-2 overflow-y-auto border-r border-divider bg-chrome/60 p-8">
						<button
							type="button"
							className={cn(
								"flex h-28 items-center gap-8 rounded-6 border-0 px-8 text-left text-meta transition-colors",
								currentDir === initialDir ? "bg-selected-nav font-medium text-ink" : "bg-transparent text-ink-body hover:bg-hover",
							)}
							onClick={() => void loadDir(initialDir)}
						>
							<Folder size={14} className="flex-none text-accent" />
							<span className="truncate">{t("documentEditor.pdf.pickerCurrentFolder")}</span>
						</button>
						{locations.slice(0, 10).map((loc) => (
							<button
								key={loc.path}
								type="button"
								className={cn(
									"flex h-28 items-center gap-8 rounded-6 border-0 px-8 text-left text-meta transition-colors",
									currentDir === loc.path ? "bg-selected-nav font-medium text-ink" : "bg-transparent text-ink-body hover:bg-hover",
								)}
								onClick={() => void loadDir(loc.path)}
							>
								{loc.section === "locations" ? (
									<HardDrive size={14} className="flex-none text-ink-muted" />
								) : (
									<Folder size={14} className="flex-none text-ink-muted" />
								)}
								<span className="truncate">{loc.name}</span>
							</button>
						))}
					</nav>

					{/* File listing / visual image grid */}
					<div className="min-h-0 flex-1 overflow-y-auto bg-window p-12">
						{loading ? (
							<div className="flex h-full items-center justify-center gap-8 text-meta text-ink-muted">
								<Loader2 size={15} className="animate-spin" />
								<span>{t("documentEditor.loading")}</span>
							</div>
						) : error !== null ? (
							<div className="flex h-full items-center justify-center text-meta text-error">{error}</div>
						) : visibleEntries.folders.length === 0 && visibleEntries.files.length === 0 ? (
							<div className="flex h-full items-center justify-center text-meta text-ink-muted">
								{mode === "image" ? t("documentEditor.pdf.pickerEmptyImages") : t("documentEditor.pdf.pickerEmptyPdfs")}
							</div>
						) : (
							<div className="flex flex-col gap-12">
								{visibleEntries.folders.length > 0 ? (
									<div className="flex flex-wrap gap-6">
										{visibleEntries.folders.map((folder) => (
											<button
												key={folder.path}
												type="button"
												data-picker-folder={folder.name}
												className="inline-flex h-28 max-w-[180px] items-center gap-6 rounded-6 border-0 bg-subtle px-10 text-meta text-ink hover:bg-hover"
												onClick={() => void loadDir(folder.path)}
											>
												<Folder size={14} className="flex-none text-accent" />
												<span className="truncate">{folder.name}</span>
											</button>
										))}
									</div>
								) : null}

								{mode === "image" ? (
									<div className="grid grid-cols-3 gap-10">
										{visibleEntries.files.map((file) => {
											const isSelected = selected.includes(file.path);
											return (
												<button
													key={file.path}
													type="button"
													data-picker-file={file.name}
													aria-pressed={isSelected}
													className={cn(
														"group flex flex-col gap-6 rounded-8 border p-6 text-left transition-colors",
														isSelected ? "border-accent bg-accent-soft" : "border-divider bg-subtle/50 hover:bg-hover",
													)}
													onClick={() => toggleSelect(file.path)}
													onDoubleClick={() => onPick([file.path])}
												>
													<div className="flex h-88 w-full items-center justify-center overflow-hidden rounded-4 bg-white ring-1 ring-black/5">
														<img
															src={previewStreamUrl(file.path, { modifiedAt: String(file.mtimeMs), size: file.size ?? 0 })}
															alt={file.name}
															loading="lazy"
															className="max-h-full max-w-full object-contain"
														/>
													</div>
													<span className="truncate text-badge text-ink">{file.name}</span>
												</button>
											);
										})}
									</div>
								) : (
									<div className="flex flex-col divide-y divide-divider rounded-8 border border-divider">
										{visibleEntries.files.map((file) => {
											const isSelected = selected.includes(file.path);
											return (
												<button
													key={file.path}
													type="button"
													data-picker-file={file.name}
													aria-pressed={isSelected}
													className={cn(
														"flex h-36 items-center gap-10 border-0 px-12 text-left text-body transition-colors",
														isSelected ? "bg-accent-soft text-accent" : "bg-window text-ink hover:bg-hover-row",
													)}
													onClick={() => toggleSelect(file.path)}
													onDoubleClick={() => {
														if (!multiple) onPick([file.path]);
													}}
												>
													<span
														className={cn(
															"flex size-16 flex-none items-center justify-center rounded-4 border",
															isSelected ? "border-accent bg-accent text-on-accent" : "border-border bg-window",
														)}
													>
														{isSelected ? <Check size={11} strokeWidth={2.5} /> : null}
													</span>
													<FileText size={15} className="flex-none text-ink-muted" />
													<span className="min-w-0 flex-1 truncate">{file.name}</span>
													<span className="flex-none text-badge tabular-nums text-ink-muted">
														{directoryLabel(currentDir)}
													</span>
												</button>
											);
										})}
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				{/* Footer */}
				<div className="flex h-48 flex-none items-center justify-between gap-8 border-t border-divider bg-chrome px-16">
					<span className="text-meta tabular-nums text-ink-muted">
						{selected.length > 0 ? directoryLabel(selected[0]!) + (selected.length > 1 ? ` (+${selected.length - 1})` : "") : ""}
					</span>
					<div className="flex items-center gap-8">
						<button
							type="button"
							className="h-28 rounded-6 border border-border bg-window px-12 text-meta font-medium text-ink hover:bg-hover-row"
							onClick={onClose}
						>
							{t("common.cancel")}
						</button>
						<button
							type="button"
							disabled={selected.length === 0}
							data-dazzi-picker-confirm="true"
							className="inline-flex h-28 items-center gap-4 rounded-6 border-0 bg-accent px-14 text-meta font-medium text-on-accent hover:opacity-90 disabled:opacity-35"
							onClick={() => {
								if (selected.length > 0) onPick(selected);
							}}
						>
							<Check size={13} />
							{confirmLabel}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
