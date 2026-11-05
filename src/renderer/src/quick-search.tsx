import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/quick-search.css";
import { setAppLanguage } from "../../shared/i18n";
import type { QuickSearchBridge } from "../../shared/quick-search-contract";
import { QuickSearch } from "./launcher/QuickSearch";

declare global {
	interface Window {
		readonly launcher: QuickSearchBridge;
	}
}

const container = document.getElementById("root");
if (container === null) throw new Error("Launcher mount point #root not found");

const bridge = window.launcher;
// Main pushes the Interface language to every window; react-i18next re-renders on a change.
bridge.onLanguage((language) => {
	void setAppLanguage(language);
	document.documentElement.lang = language;
});
void setAppLanguage(bridge.language).then(() => {
	document.documentElement.lang = bridge.language;
	createRoot(container).render(
		<StrictMode>
			<QuickSearch bridge={bridge} />
		</StrictMode>,
	);
});
