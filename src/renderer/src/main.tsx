import "./lib/error-reporting";
import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import "../styles/app.css";
import { App } from "./App";
import { MobileApp } from "./mobile/MobileApp";
import { useMobileShell } from "./mobile/device";
import { applyInterfaceLanguage } from "./lib/interface-language";

/**
 * One window: the Finder, which on a first run carries the first-run layer (`first-run/FirstRun.tsx`).
 * A remote browser session on a phone-sized screen gets the phone shell instead; it is never a first run
 * (the bootstrap reports `pending: false`).
 */
function Root(): ReactElement {
	return useMobileShell() ? <MobileApp /> : <App />;
}
const container = document.getElementById("root");
if (container === null) {
	throw new Error("Renderer mount point #root not found");
}

// Render only once the window is in the stored interface language, so no screen paints in the Korean default first.
// The one window is the Finder; on a first run it carries the first-run layer (`first-run/FirstRun.tsx`).
void applyInterfaceLanguage(window.autorag.settings).then(() => {
	createRoot(container).render(
		<StrictMode>
			<Root />
		</StrictMode>,
	);
});
