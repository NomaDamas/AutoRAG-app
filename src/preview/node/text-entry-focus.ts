export interface TextEntryWindow {
	readonly webContents: { focus(): void };
	isDestroyed(): boolean;
	isVisible(): boolean;
	once(event: "show", listener: () => void): void;
	show(): void;
	focus(): void;
}

/** Focus a text entry window now, or after Electron finishes showing it. */
export function focusTextEntry(window: TextEntryWindow, isTyping: () => boolean): void {
	if (!isTyping() || window.isDestroyed()) return;
	if (!window.isVisible()) {
		window.once("show", () => focusTextEntry(window, isTyping));
		return;
	}
	window.show();
	window.focus();
	window.webContents.focus();
}
