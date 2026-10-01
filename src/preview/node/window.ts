import { extname } from "node:path";
import { app, BrowserWindow, ipcMain, screen, shell, type IpcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import {
	isQuickLookAction,
	isQuickLookReady,
	isQuickLookTarget,
	PREVIEW_CHANNELS,
	type NavigateDelta,
	type PreviewDocument,
	type QuickLookAction,
	type QuickLookLoad,
	type QuickLookReady,
	type QuickLookTarget,
} from "../shared/contract";
import { fitQuickLook, placeQuickLook, QUICK_LOOK_MIN } from "../shared/fit";
import { viewerForExtension, wantsBytes } from "../shared/registry";
import { PreviewReadError, readPreviewFile } from "./read-file";

/** Media reports its size once decoded; anything slower still shows by then. */
const SHOW_DEADLINE_MS = 250;

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
	shown: boolean;
	deadline: NodeJS.Timeout | null;
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

function present(state: Session, report: QuickLookReady): void {
	clearDeadline(state);
	const { window } = state;
	if (!live(window) || state.current === null) return;
	if (!window.isFullScreen()) {
		const workArea = workAreaFor(state);
		const size = fitQuickLook(report, workArea);
		const bounds = placeQuickLook(size, state.shown ? window.getBounds() : null, workArea);
		window.setBounds(bounds, state.shown && process.platform === "darwin");
	}
	if (state.shown) return;
	state.shown = true;
	float(state, true);
	window.showInactive();
}

function hide(state: Session, notifyOwner: boolean): void {
	state.seq += 1;
	state.current = null;
	clearDeadline(state);
	const { window, owner } = state;
	if (live(window)) {
		window.webContents.send(PREVIEW_CHANNELS.unload);
		if (state.shown) {
			const refocusOwner = window.isFocused();
			float(state, false);
			if (window.isFullScreen()) {
				window.once("leave-full-screen", () => window.hide());
				window.setFullScreen(false);
			} else {
				window.hide();
			}
			if (refocusOwner && live(owner)) owner.focus();
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

async function show(state: Session, target: QuickLookTarget): Promise<void> {
	state.seq += 1;
	const seq = state.seq;
	state.current = target;
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
		backgroundColor: "#F6F6F8",
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
		shown: false,
		deadline: null,
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
	const onOwnerClosed = (): void => state.detach();

	window.on("close", onClose);
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
	ipc.handle(PREVIEW_CHANNELS.show, async (event, target: unknown) => {
		const state = fromOwner(event);
		if (!isQuickLookTarget(target)) throw new Error("미리보기 요청이 올바르지 않습니다");
		await show(state, target);
	});
	ipc.handle(PREVIEW_CHANNELS.hide, (event) => {
		hide(fromOwner(event), false);
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
