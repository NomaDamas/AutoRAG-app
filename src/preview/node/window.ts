import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { t } from "../../shared/i18n/core";
import { LANGUAGE_FLAG } from "../../shared/language-contract";
import type { AppAppearance, AppSettings } from "../../shared/settings-contract";
import type { IconPreviewCache } from "../../main/file-icon";
import { isAppBundle } from "../../main/fs-entry";
import {
	app,
	BrowserWindow,
	clipboard,
	ipcMain,
	nativeTheme,
	screen,
	ShareMenu,
	shell,
	type IpcMain,
	type IpcMainEvent,
	type IpcMainInvokeEvent,
} from "electron";
import {
	isBounds,
	isPreviewPrefetch,
	isQuickLookAction,
	isQuickLookReady,
	isQuickLookTarget,
	isQuickLookZoomed,
	PREVIEW_CHANNELS,
	type BundleSummary,
	type FolderSummary,
	type NavigateDelta,
	type OfficePage,
	type PreviewDocument,
	type QuickLookAction,
	type QuickLookApp,
	type QuickLookLoad,
	type QuickLookOffice,
	type QuickLookReady,
	type QuickLookTarget,
	type QuickLookZoom,
} from "../shared/contract";
import { looksLikeText } from "../shared/text-sample";
import { type Bounds, fitQuickLook, placeQuickLook, QUICK_LOOK_MIN } from "../shared/fit";
import { quickLookKeyAction } from "../shared/keys";
import { sniffLegacyContainer } from "../shared/legacy-office";
import { isGoogleDriveExtension } from "../shared/google-drive";
import { byteNeed, viewerForExtension } from "../shared/registry";
import { fallbackOrigin, screenOrigin, ZOOM_DONE_TIMEOUT_MS, zoomGeometry } from "../shared/zoom";
import { readAudioMetadata } from "./audio-metadata";
import { previewData } from "./data";
import { driveThumbnail } from "./google-drive";
import { type BundleIconSource, summarizeBundle } from "./bundle";
import { createDefaultAppCache, type DefaultAppCache } from "./default-app";
import { fileDetails, sha256File } from "./details";
import { measureFolder, summarizeFolder } from "./folder";
import { readHeicPreview } from "./heic";
import { readTiffPreview } from "./tiff";
import { readIworkPreview } from "./iwork";
import { createOfficeRenderCache, openOffice, type OfficeRenderCache } from "./office-render";
import { readEmbeddedThumbnail } from "./odf";
import { PREVIEW_BYTE_CAP, PreviewReadError, readPreviewFile, SNIFF_BYTES, TEXT_BYTE_CAP } from "./read-file";

/** Media reports its size once decoded; anything slower still shows by then. */
const SHOW_DEADLINE_MS = 250;
/** How long the zoom waits on the page for a step before moving on without it. */
const ZOOM_PREPARE_MS = 120;
/**
 * The zoom needs a transparent window: it briefly covers the icon and the panel
 * together, and only the scaled panel inside it may be visible.
 */
const ZOOMS = process.platform === "darwin";
/** Children a folder preview lists. */
const FOLDER_PREVIEW_ITEMS = 6;
/** A folder's size walk gives up here and reports a lower bound. */
const FOLDER_SIZE_BUDGET = { maxEntries: 200_000, maxMs: 2500 } as const;
/**
 * macOS blurs what is behind the panel with a native material, the same one
 * Quick Look uses; CSS `backdrop-filter` cannot see past the window.
 */
const MATERIAL = "hud";
/** Opaque panel colors for platforms without a transparent window. */
const SOLID_PANEL = { light: "#F2F2F4", dark: "#2A2A2C" } as const;

export interface QuickLookWindowOptions {
	readonly preload: string;
	readonly appearance: AppAppearance;
	readonly language: AppSettings["language"];
	readonly loadPage: (window: BrowserWindow) => void;
	/** The app that opens `path`, or null; main hands this to the fs worker so no child spawns here. */
	readonly defaultApp: (path: string) => Promise<string | null>;
}

interface Session {
	readonly owner: BrowserWindow;
	readonly window: BrowserWindow;
	readonly loaded: Promise<void>;
	seq: number;
	current: QuickLookTarget | null;
	/** Screen rect of the current file's Finder icon; the panel zooms out of and back into it. */
	origin: Bounds | null;
	shown: boolean;
	deadline: NodeJS.Timeout | null;
	/** Bumped by every zoom; a zoom whose id is stale stops at its next step. */
	zoom: number;
	/** The open zoom still running; its final bounds follow navigation that lands meanwhile. */
	opening: { readonly id: number; bounds: Bounds } | null;
	/** A close zoom is running: the content must stay until the panel has shrunk away. */
	closing: boolean;
	readonly waiters: Map<string, () => void>;
	readonly defaultApps: DefaultAppCache;
	detach: () => void;
}

let session: Session | null = null;
let quitting = false;
/**
 * The main process's icon provider, for the one target the preview draws an
 * OS icon for: a macOS application bundle (see {@link summarizeBundle}).
 * Null in unit tests and before `registerQuickLookIpc` runs; the panel keeps
 * its glyph then.
 */
let iconSource: (BundleIconSource & Partial<Pick<IconPreviewCache, "cachedPreview">>) | null = null;
/** The Office pages macOS drew, rendered ahead of Space when the Finder selects a legacy Office file. */
let officePages: OfficeRenderCache = createOfficeRenderCache();

function live(window: BrowserWindow): boolean {
	return !window.isDestroyed();
}

function clearDeadline(state: Session): void {
	if (state.deadline === null) return;
	clearTimeout(state.deadline);
	state.deadline = null;
}

function float(state: Session, on: boolean): void {
	if (process.platform !== "darwin" || !live(state.window)) return;
	state.window.setAlwaysOnTop(on, "floating");
}

function workAreaFor(state: Session): Electron.Rectangle {
	const anchor = state.shown ? state.window.getBounds() : state.owner.getBounds();
	return screen.getDisplayMatching(anchor).workArea;
}

function sendZoom(state: Session, zoom: QuickLookZoom): void {
	if (live(state.window)) state.window.webContents.send(PREVIEW_CHANNELS.zoom, zoom);
}

/** Resolves when the page reports the zoom step, or after `ms` if it never does. */
function zoomStep(state: Session, id: number, phase: "prepared" | "done", ms: number): Promise<void> {
	const key = `${id}:${phase}`;
	const { promise, resolve } = Promise.withResolvers<void>();
	const finish = (): void => {
		clearTimeout(timer);
		state.waiters.delete(key);
		resolve();
	};
	const timer = setTimeout(finish, ms);
	state.waiters.set(key, finish);
	return promise;
}

function current(state: Session, id: number): boolean {
	return id === state.zoom && live(state.window);
}

/**
 * The native blur behind the panel. It fills the whole window, so it is off
 * while a zoom stretches the window over the icon and the Finder around it.
 */
function material(state: Session, on: boolean): void {
	if (process.platform !== "darwin" || !live(state.window)) return;
	state.window.setVibrancy(on ? MATERIAL : null, { animationDuration: on ? 120 : 0 });
}

/** Returns the window to its resting state: opaque, shadowed, and clickable. */
function resetZoomWindow(state: Session): void {
	state.closing = false;
	state.window.setOpacity(1);
	state.window.setHasShadow(true);
	state.window.setIgnoreMouseEvents(false);
}

/** While a zoom runs the window covers Finder around the panel; clicks pass through. */
function beginZoom(state: Session): number {
	state.zoom += 1;
	state.window.setHasShadow(false);
	state.window.setIgnoreMouseEvents(true);
	return state.zoom;
}

/**
 * Finder's Quick Look open: the panel, laid out at its final size, starts
 * scaled down over the file's icon and grows into place on an accelerating
 * curve. The window covers icon and panel while it runs, then snaps to the
 * panel; the page anchors the panel to their shared edges so the snap is still.
 */
async function zoomIn(state: Session, bounds: Bounds): Promise<void> {
	const { window } = state;
	const id = beginZoom(state);
	state.closing = false;
	const opening = { id, bounds };
	state.opening = opening;
	const geometry = zoomGeometry(state.origin ?? fallbackOrigin(bounds), bounds);
	// Pose the panel while the window is still hidden: the first frame it shows is
	// already the small panel over the icon, never a full-size one.
	window.setBounds(geometry.union);
	sendZoom(state, { id, phase: "prepare", direction: "in", geometry });
	await zoomStep(state, id, "prepared", ZOOM_PREPARE_MS);
	if (!current(state, id)) return;
	window.showInactive();
	sendZoom(state, { id, phase: "run" });
	await zoomStep(state, id, "done", ZOOM_DONE_TIMEOUT_MS);
	if (!current(state, id)) return;
	state.opening = null;
	window.setBounds(opening.bounds);
	sendZoom(state, { id, phase: "settle" });
	resetZoomWindow(state);
	material(state, true);
}

/** The reverse: the panel shrinks back into the icon, accelerating, then the window hides. */
async function zoomOut(state: Session, origin: Bounds | null): Promise<void> {
	const { window } = state;
	const id = beginZoom(state);
	state.closing = true;
	material(state, false);
	const bounds = window.getBounds();
	const geometry = zoomGeometry(origin ?? fallbackOrigin(bounds), bounds);
	sendZoom(state, { id, phase: "prepare", direction: "out", geometry });
	await zoomStep(state, id, "prepared", ZOOM_PREPARE_MS);
	if (!current(state, id)) return;
	window.setBounds(geometry.union);
	sendZoom(state, { id, phase: "run" });
	await zoomStep(state, id, "done", ZOOM_DONE_TIMEOUT_MS);
	if (!current(state, id)) return;
	window.hide();
	resetZoomWindow(state);
	window.webContents.send(PREVIEW_CHANNELS.unload);
	sendZoom(state, { id, phase: "settle" });
}

function present(state: Session, report: QuickLookReady): void {
	clearDeadline(state);
	const { window } = state;
	if (!live(window) || state.current === null) return;
	if (!window.isFullScreen()) {
		const workArea = workAreaFor(state);
		const size = fitQuickLook(report, workArea, report.fit);
		const previous = state.opening?.bounds ?? (state.shown ? window.getBounds() : null);
		const bounds = placeQuickLook(size, previous, workArea);
		if (!state.shown && ZOOMS) {
			state.shown = true;
			float(state, true);
			void zoomIn(state, bounds);
			return;
		}
		if (state.opening !== null) {
			state.opening.bounds = bounds;
		} else {
			window.setBounds(bounds, state.shown && process.platform === "darwin");
		}
	}
	if (state.shown) return;
	state.shown = true;
	float(state, true);
	window.showInactive();
}

function hide(state: Session, notifyOwner: boolean, origin: Bounds | null = state.origin): void {
	state.seq += 1;
	state.current = null;
	clearDeadline(state);
	const { window, owner } = state;
	if (live(window)) {
		const opening = state.opening !== null;
		state.opening = null;
		if (state.shown) {
			const refocusOwner = window.isFocused();
			float(state, false);
			if (window.isFullScreen()) {
				window.webContents.send(PREVIEW_CHANNELS.unload);
				window.once("leave-full-screen", () => {
					material(state, false);
					window.hide();
				});
				window.setFullScreen(false);
			} else if (ZOOMS && !opening) {
				void zoomOut(state, origin);
			} else {
				// Closing mid-open (or without a transparent window) hides at once.
				state.zoom += 1;
				material(state, false);
				window.hide();
				resetZoomWindow(state);
				window.webContents.send(PREVIEW_CHANNELS.unload);
				sendZoom(state, { id: state.zoom, phase: "settle" });
			}
			if (refocusOwner && live(owner)) owner.focus();
		} else if (!state.closing) {
			window.webContents.send(PREVIEW_CHANNELS.unload);
		}
	}
	state.shown = false;
	if (notifyOwner && live(owner)) owner.webContents.send(PREVIEW_CHANNELS.closed);
}

interface TargetContent {
	readonly document: PreviewDocument | null;
	readonly folder: FolderSummary | null;
	readonly bundle: BundleSummary | null;
	readonly error: string | null;
}

function isUnreadableFolder(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}

async function readFolder(path: string): Promise<TargetContent> {
	try {
		return { document: null, folder: await summarizeFolder(path, FOLDER_PREVIEW_ITEMS), bundle: null, error: null };
	} catch (error) {
		if (isUnreadableFolder(error)) return { document: null, folder: null, bundle: null, error: t("quickLook.errors.unreadableFolder") };
		throw error;
	}
}

/**
 * Reads only what the viewer will use: nothing for streamed media and PDF,
 * the first 4MB of text, whole documents up to 32MB, and a 64KB sniff of an
 * unknown file, which is read on as text only when it looks like text.
 */
async function readDocument(path: string): Promise<PreviewDocument> {
	const kind = viewerForExtension(extname(path).slice(1));
	if (kind === "legacyDoc" || kind === "legacyPpt") {
		// The whole file for the text reader. What macOS draws for it arrives
		// separately (`openOfficePage`): the panel must not wait for it.
		return readPreviewFile(path, PREVIEW_BYTE_CAP, true);
	}
	switch (byteNeed(kind)) {
		case "stream":
		case "query":
			return readPreviewFile(path, 0);
		case "prefix":
			return readPreviewFile(path, TEXT_BYTE_CAP);
		case "whole":
			return readPreviewFile(path, PREVIEW_BYTE_CAP, true);
		case "decode":
			return kind === "tiff" ? readTiffPreview(path) : readHeicPreview(path);
		case "extract": {
			if (viewerForExtension(extname(path).slice(1)) === "odg") {
				const document = await readPreviewFile(path, 0);
				const thumbnail = (await readEmbeddedThumbnail(path, "odg").catch((error: unknown) => {
					console.warn(`quick-look: OpenDocument thumbnail for ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
					return null;
				}))?.bytes ?? null;
				return { ...document, bytes: thumbnail };
			}
			// The file's own metadata, the page image Apple stored inside it, and
			// (for a Keynote deck) every slide image in show order.
			const document = await readPreviewFile(path, 0);
			const preview = await readIworkPreview(path).catch((error: unknown) => {
				console.warn(`quick-look: iWork preview for ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
				return null;
			});
			return { ...document, bytes: preview?.firstPage ?? null, pages: preview?.pages ?? null };
		}
		case "sniff": {
			const sniffed = await readPreviewFile(path, SNIFF_BYTES);
			if (!sniffed.truncated || sniffed.bytes === null || !looksLikeText(sniffed.bytes)) return sniffed;
			return readPreviewFile(path, TEXT_BYTE_CAP);
		}
	}
}

async function readTarget(target: QuickLookTarget): Promise<TargetContent> {
	try {
		return { document: await readDocument(target.path), folder: null, bundle: null, error: null };
	} catch (error) {
		if (error instanceof PreviewReadError && error.code === "not-file") {
			// A macOS application bundle is a directory, but the OS opens it as
			// one app: the panel shows the app, never its `Contents/`.
			if (isAppBundle(basename(target.path), true, process.platform)) {
				return { document: null, folder: null, bundle: await summarizeBundle(target.path, iconSource), error: null };
			}
			return readFolder(target.path);
		}
		if (error instanceof PreviewReadError) return { document: null, folder: null, bundle: null, error: error.message };
		throw error;
	}
}

/**
 * A legacy Office document opens now with what is already known about the page
 * macOS draws for it (see {@link openOffice}); the rest follows on the `office`
 * channel. Only a real compound file is handed to the OS.
 */
async function withOffice(state: Session, seq: number, target: QuickLookTarget, content: TargetContent): Promise<TargetContent> {
	const document = content.document;
	if (document === null || document.bytes === null) return content;
	const kind = viewerForExtension(document.ext);
	if ((kind !== "legacyDoc" && kind !== "legacyPpt") || sniffLegacyContainer(document.bytes) !== "ole") return content;
	const info = await stat(target.path);
	const file = { path: target.path, mtimeMs: info.mtimeMs, size: info.size };
	const icon = { path: target.path, ext: document.ext, mtimeMs: info.mtimeMs };
	const office = openOffice(file, {
		cache: officePages,
		firstPage: {
			peek: () => iconSource?.cachedPreview?.(icon) ?? null,
			load: () => iconSource?.preview(icon) ?? Promise.resolve(null),
		},
		publish: (next) => {
			const update: QuickLookOffice = { seq, office: next };
			if (live(state.window)) state.window.webContents.send(PREVIEW_CHANNELS.office, update);
		},
		current: () => seq === state.seq && live(state.window),
	});
	return { ...content, document: { ...document, office } };
}

/**
 * A Google Drive pointer opens with the picture Drive for desktop's file
 * provider drew for it (the one thing Quick Look can show of a cloud-only
 * document); every other document passes through untouched.
 */
async function withDriveThumbnail(target: QuickLookTarget, content: TargetContent): Promise<TargetContent> {
	const document = content.document;
	if (document === null || !isGoogleDriveExtension(document.ext)) return content;
	const { mtimeMs } = await stat(target.path);
	const thumbnail = await driveThumbnail({ path: target.path, ext: document.ext, mtimeMs }, iconSource);
	return { ...content, document: { ...document, thumbnail } };
}

async function show(state: Session, target: QuickLookTarget, origin: Bounds | null): Promise<void> {
	state.seq += 1;
	const seq = state.seq;
	state.current = target;
	state.origin = origin;
	const [read] = await Promise.all([readTarget(target), state.loaded]);
	if (seq !== state.seq || !live(state.window)) return;
	const withOfficePage = await withOffice(state, seq, target, read);
	if (seq !== state.seq || !live(state.window)) return;
	const content = await withDriveThumbnail(target, withOfficePage);
	if (seq !== state.seq || !live(state.window)) return;
	const folder = content.folder !== null;
	// An app bundle is launched by the Open button itself, so there is no
	// "Open with" app to name: the button stays "Open".
	const launched = content.bundle !== null;
	const known = launched ? null : state.defaultApps.known(target.path, folder);
	const load: QuickLookLoad = { seq, name: target.name, path: target.path, ...content, app: known, anchor: target.anchor ?? null };
	state.window.setTitle(target.name);
	state.window.webContents.send(PREVIEW_CHANNELS.load, load);
	if (known === null && !launched && content.error === null) {
		void state.defaultApps.resolve(target.path, folder).then((name) => {
			if (seq !== state.seq || !live(state.window)) return;
			const update: QuickLookApp = { seq, name };
			state.window.webContents.send(PREVIEW_CHANNELS.app, update);
		});
	}
	clearDeadline(state);
	state.deadline = setTimeout(() => {
		if (seq === state.seq) present(state, { seq, width: 0, height: 0, fit: "clamp" });
	}, SHOW_DEADLINE_MS);
}

async function act(state: Session, action: QuickLookAction): Promise<void> {
	const navigate = (delta: NavigateDelta): void => {
		if (live(state.owner)) state.owner.webContents.send(PREVIEW_CHANNELS.navigate, delta);
	};
	switch (action) {
		case "close":
			hide(state, true);
			return;
		case "next":
			navigate(1);
			return;
		case "previous":
			navigate(-1);
			return;
		case "fullscreen":
			state.window.setFullScreen(!state.window.isFullScreen());
			return;
		case "open": {
			if (state.current === null) return;
			const message = await shell.openPath(state.current.path);
			if (message !== "") throw new Error(message);
			return;
		}
		case "reveal":
			if (state.current !== null) shell.showItemInFolder(state.current.path);
			return;
	}
}

function fromOwner(event: IpcMainInvokeEvent): Session {
	if (session === null || !live(session.owner) || event.sender !== session.owner.webContents) {
		throw new Error("Quick Look is not attached to this window");
	}
	return session;
}

function fromPreview(event: IpcMainInvokeEvent | IpcMainEvent): Session | null {
	if (session === null || !live(session.window) || event.sender !== session.window.webContents) return null;
	return session;
}

/**
 * The shown path, when the preview window asks about it. The preview page may
 * only learn about the file or folder it is showing, never an arbitrary path.
 */
function shownPath(event: IpcMainInvokeEvent, path: unknown): { readonly state: Session; readonly path: string } {
	const state = fromPreview(event);
	if (state === null) throw new Error("Quick Look is not attached to this window");
	if (typeof path !== "string" || state.current?.path !== path) throw new Error(t("quickLook.errors.notShowing"));
	return { state, path };
}

/** The Finder sends its icon rect in page CSS pixels; the zoom needs it on screen. */
function ownerOrigin(state: Session, origin: unknown): Bounds | null {
	if (!isBounds(origin) || !live(state.owner)) return null;
	return screenOrigin(state.owner.getContentBounds(), origin, state.owner.webContents.getZoomFactor());
}

/**
 * Pre-creates the hidden Quick Look window for `owner` (sigma-file-manager
 * v1's pre-warmed quick view window) so Space only has to send a file to an
 * already loaded page. The window hides instead of closing and is reused.
 */
export function attachQuickLook(owner: BrowserWindow, options: QuickLookWindowOptions): void {
	if (session !== null) session.detach();
	const darwin = process.platform === "darwin";
	const solid = (): string => (nativeTheme.shouldUseDarkColors ? SOLID_PANEL.dark : SOLID_PANEL.light);
	const window = new BrowserWindow({
		show: false,
		width: 880,
		height: 640,
		minWidth: QUICK_LOOK_MIN.width,
		minHeight: QUICK_LOOK_MIN.height,
		title: "Quick Look",
		// Translucent panel over the Finder, like macOS Quick Look: the preview
		// chrome is semi-transparent and the window is sized to the content.
		transparent: darwin,
		backgroundColor: darwin ? "#00000000" : solid(),
		// The panel is shown without taking focus; the blur must not go flat for that.
		...(darwin ? { visualEffectState: "active" as const } : {}),
		hasShadow: true,
		titleBarStyle: "hidden",
		minimizable: false,
		fullscreenable: true,
		skipTaskbar: true,
		...(darwin ? {} : { parent: owner }),
		webPreferences: {
			preload: options.preload,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			spellcheck: false,
			backgroundThrottling: false,
			autoplayPolicy: "no-user-gesture-required",
			additionalArguments: [`--autorag-appearance=${options.appearance}`, `${LANGUAGE_FLAG}${options.language}`],
		},
	});
	if (darwin) window.setWindowButtonVisibility(false);
	// Previewed HTML and Markdown can carry links; none of them may replace the preview page.
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	const loaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
	const state: Session = {
		owner,
		window,
		loaded,
		seq: 0,
		current: null,
		origin: null,
		shown: false,
		deadline: null,
		zoom: 0,
		opening: null,
		closing: false,
		waiters: new Map(),
		defaultApps: createDefaultAppCache(options.defaultApp),
		detach: () => undefined,
	};

	const onClose = (event: Electron.Event): void => {
		if (quitting || !live(owner)) return;
		event.preventDefault();
		hide(state, true);
	};
	const onResignActive = (): void => float(state, false);
	const onBecomeActive = (): void => {
		if (state.shown) float(state, true);
	};
	const onTheme = (): void => {
		if (!darwin && live(window)) window.setBackgroundColor(solid());
	};
	const onOwnerLoad = (): void => hide(state, false);
	// Keys run here, before the page: a focused <video> lets its native controls
	// consume Space and arrows, so a page keydown listener never sees them.
	const onInput = (event: Electron.Event, input: Electron.Input): void => {
		if (input.type !== "keyDown") return;
		const action = quickLookKeyAction(input);
		if (action === null) return;
		event.preventDefault();
		if (action === "close" && input.isAutoRepeat) return;
		void act(state, action);
	};
	const onOwnerClosed = (): void => state.detach();

	window.on("close", onClose);
	window.webContents.on("before-input-event", onInput);
	app.on("did-resign-active", onResignActive);
	app.on("did-become-active", onBecomeActive);
	nativeTheme.on("updated", onTheme);
	owner.webContents.on("did-finish-load", onOwnerLoad);
	owner.once("closed", onOwnerClosed);
	state.detach = () => {
		clearDeadline(state);
		app.off("did-resign-active", onResignActive);
		app.off("did-become-active", onBecomeActive);
		nativeTheme.off("updated", onTheme);
		if (live(owner)) {
			owner.webContents.off("did-finish-load", onOwnerLoad);
			owner.off("closed", onOwnerClosed);
		}
		if (live(window)) window.destroy();
		if (session === state) session = null;
	};
	session = state;
	options.loadPage(window);
}

export function registerQuickLookIpc(icons: (BundleIconSource & Partial<Pick<IconPreviewCache, "cachedPreview">>) | null = null, ipc: IpcMain = ipcMain): void {
	iconSource = icons;
	app.on("before-quit", () => {
		quitting = true;
	});
	ipc.handle(PREVIEW_CHANNELS.show, async (event, target: unknown, origin: unknown) => {
		const state = fromOwner(event);
		if (!isQuickLookTarget(target)) throw new Error(t("quickLook.errors.invalidTarget"));
		await show(state, target, ownerOrigin(state, origin));
	});
	ipc.on(PREVIEW_CHANNELS.prefetch, (event, file: unknown) => {
		if (session === null || !live(session.owner) || event.sender !== session.owner.webContents || !isPreviewPrefetch(file)) return;
		const kind = viewerForExtension(extname(file.path).slice(1));
		if (kind !== "legacyDoc" && kind !== "legacyPpt") return;
		officePages.prefetch(file);
		// The OS thumbnail is ready in tens of milliseconds and keeps the panel from opening blank.
		void iconSource?.preview({ path: file.path, ext: extname(file.path).slice(1).toLowerCase(), mtimeMs: file.mtimeMs }).catch(() => null);
	});
	ipc.handle(PREVIEW_CHANNELS.hide, (event, origin: unknown) => {
		const state = fromOwner(event);
		hide(state, false, ownerOrigin(state, origin) ?? state.origin);
	});
	ipc.on(PREVIEW_CHANNELS.zoomed, (event, report: unknown) => {
		const state = fromPreview(event);
		if (state === null || !isQuickLookZoomed(report)) return;
		state.waiters.get(`${report.id}:${report.phase}`)?.();
	});
	ipc.on(PREVIEW_CHANNELS.ready, (event, report: unknown) => {
		const state = fromPreview(event);
		if (state === null || !isQuickLookReady(report) || report.seq !== state.seq) return;
		present(state, report);
	});
	ipc.handle(PREVIEW_CHANNELS.request, async (event, action: unknown) => {
		const state = fromPreview(event);
		if (state === null) throw new Error("Quick Look is not attached to this window");
		if (!isQuickLookAction(action)) throw new Error(t("quickLook.errors.unknownAction"));
		await act(state, action);
	});
	ipc.handle(PREVIEW_CHANNELS.details, (event, path: unknown) => fileDetails(shownPath(event, path).path));
	ipc.handle(PREVIEW_CHANNELS.sha256, async (event, path: unknown) => {
		const shown = shownPath(event, path);
		const digest = await sha256File(shown.path, () => shown.state.current?.path !== shown.path);
		if (digest === null) throw new Error(t("quickLook.errors.changedWhileHashing"));
		return digest;
	});
	ipc.handle(PREVIEW_CHANNELS.folderSize, (event, path: unknown) => {
		const shown = shownPath(event, path);
		return measureFolder(shown.path, { ...FOLDER_SIZE_BUDGET, stopped: () => shown.state.current?.path !== shown.path });
	});
	ipc.handle(PREVIEW_CHANNELS.audioMetadata, (event, path: unknown) => readAudioMetadata(shownPath(event, path).path));
	ipc.handle(PREVIEW_CHANNELS.data, (event, path: unknown, table: unknown) => {
		if (table !== null && typeof table !== "string") throw new Error(t("quickLook.errors.invalidTarget"));
		return previewData(shownPath(event, path).path, table);
	});
	ipc.handle(PREVIEW_CHANNELS.share, (event, anchor: unknown) => {
		const state = fromPreview(event);
		if (state === null || state.current === null || process.platform !== "darwin") return;
		if (!isBounds(anchor)) throw new Error(t("quickLook.errors.invalidShareAnchor"));
		new ShareMenu({ filePaths: [state.current.path] }).popup({
			window: state.window,
			x: Math.round(anchor.x),
			y: Math.round(anchor.y + anchor.height + 4),
		});
	});
	ipc.handle(PREVIEW_CHANNELS.copyText, (event, text: unknown) => {
		if (fromPreview(event) === null) throw new Error("Quick Look is not attached to this window");
		if (typeof text !== "string") throw new Error(t("quickLook.errors.invalidCopyText"));
		clipboard.writeText(text);
	});
}
