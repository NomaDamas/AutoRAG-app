import "./lib/error-reporting";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/app.css";
import { App } from "./App";
import { applyInterfaceLanguage } from "./lib/interface-language";

const container = document.getElementById("root");
if (container === null) {
	throw new Error("Renderer mount point #root not found");
}

// Render only once the window is in the stored interface language, so no screen paints in the Korean default first.
// The one window is the Finder; on a first run it carries the first-run layer (`first-run/FirstRun.tsx`).
void applyInterfaceLanguage(window.autorag.settings).then(() => {
	createRoot(container).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
});
