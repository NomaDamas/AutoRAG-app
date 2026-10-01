import { extname } from "node:path";
import { app, BrowserWindow, ipcMain, screen, shell, type IpcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
	isBounds,
	isQuickLookAction,
	isQuickLookReady,
	isQuickLookTarget,
	isQuickLookZoomed,
	PREVIEW_CHANNELS,
	type NavigateDelta,
	type PreviewDocument,
	type QuickLookAction,
	type QuickLookLoad,
	type QuickLookReady,
	type QuickLookTarget,
	type QuickLookZoom,
} from "../shared/contract";
import { type Bounds, fitQuickLook, placeQuickLook, QUICK_LOOK_MIN } from "../shared/fit";
import { quickLookKeyAction } from "../shared/keys";
import { viewerForExtension, wantsBytes } from "../shared/registry";
import { fallbackOrigin, screenOrigin, ZOOM_IN_MS, ZOOM_OUT_MS, zoomGeometry } from "../shared/zoom";
import { PreviewReadError, readPreviewFile } from "./read-file";

/** Media reports its size once decoded; anything slower still shows by then. */
const SHOW_DEADLINE_MS = 250;
/** How long the zoom waits on the page for a step before moving on without it. */
const ZOOM_PREPARE_MS = 120;
const ZOOM_SLACK_MS = 120;
/**
 * The zoom needs a transparent window: it briefly covers the icon and the panel
 * together, and only the scaled panel inside it may be visible.
 */
const ZOOMS = process.platform === "darwin";

export interface QuickLookWindowOptions {
	readonly preload: string;
	readonly loadPage: (window: BrowserWindow) => void;
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
	detach: () => void;
}

let session: Session | null = null;
let quitting = false;

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
	await zoomStep(state, id, "done", ZOOM_IN_MS + ZOOM_SLACK_MS);
	if (!current(state, id)) return;
	state.opening = null;
	window.setBounds(opening.bounds);
	sendZoom(state, { id, phase: "settle" });
	resetZoomWindow(state);
}

/** The reverse: the panel shrinks back into the icon, accelerating, then the window hides. */
async function zoomOut(state: Session, origin: Bounds | null): Promise<void> {
	const { window } = state;
	const id = beginZoom(state);
	state.closing = true;
	const bounds = window.getBounds();
	const geometry = zoomGeometry(origin ?? fallbackOrigin(bounds), bounds);
	sendZoom(state, { id, phase: "prepare", direction: "out", geometry });
	await zoomStep(state, id, "prepared", ZOOM_PREPARE_MS);
	if (!current(state, id)) return;
	window.setBounds(geometry.union);
	sendZoom(state, { id, phase: "run" });
	await zoomStep(state, id, "done", ZOOM_OUT_MS + ZOOM_SLACK_MS);
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
		const size = fitQuickLook(report, workArea);
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
				window.once("leave-full-screen", () => window.hide());
				window.setFullScreen(false);
			} else if (ZOOMS && !opening) {
				void zoomOut(state, origin);
			} else {
				// Closing mid-open (or without a transparent window) hides at once.
				state.zoom += 1;
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

async function readTarget(target: QuickLookTarget): Promise<{ readonly document: PreviewDocument | null; readonly error: string | null }> {
	const kind = viewerForExtension(extname(target.path).slice(1));
	try {
		return { document: await readPreviewFile(target.path, wantsBytes(kind)), error: null };
	} catch (error) {
		if (error instanceof PreviewReadError) return { document: null, error: error.message };
		throw error;
	}
}

async function show(state: Session, target: QuickLookTarget, origin: Bounds | null): Promise<void> {
	state.seq += 1;
	const seq = state.seq;
	state.current = target;
	state.origin = origin;
	const [{ document, error }] = await Promise.all([readTarget(target), state.loaded]);
	if (seq !== state.seq || !live(state.window)) return;
	const load: QuickLookLoad = { seq, name: target.name, path: target.path, document, error };
	state.window.setTitle(target.name);
	state.window.webContents.send(PREVIEW_CHANNELS.load, load);
	clearDeadline(state);
	state.deadline = setTimeout(() => {
		if (seq === state.seq) present(state, { seq, width: 0, height: 0 });
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
		backgroundColor: darwin ? "#00000000" : "#F6F6F8",
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
		},
	});
	if (darwin) window.setWindowButtonVisibility(false);
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
	owner.webContents.on("did-finish-load", onOwnerLoad);
	owner.once("closed", onOwnerClosed);
	state.detach = () => {
		clearDeadline(state);
		app.off("did-resign-active", onResignActive);
		app.off("did-become-active", onBecomeActive);
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

export function registerQuickLookIpc(ipc: IpcMain = ipcMain): void {
	app.on("before-quit", () => {
		quitting = true;
	});
	ipc.handle(PREVIEW_CHANNELS.show, async (event, target: unknown, origin: unknown) => {
		const state = fromOwner(event);
		if (!isQuickLookTarget(target)) throw new Error("미리보기 요청이 올바르지 않습니다");
		await show(state, target, ownerOrigin(state, origin));
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
		if (!isQuickLookAction(action)) throw new Error("알 수 없는 Quick Look 동작입니다");
		await act(state, action);
	});
}
