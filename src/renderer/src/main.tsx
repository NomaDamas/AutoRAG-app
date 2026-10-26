import "./lib/error-reporting";
import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import "../styles/app.css";
import { App } from "./App";
import { Onboarding } from "./onboarding/Onboarding";
import { applyInterfaceLanguage } from "./lib/interface-language";

/** Onboarding found nothing left to do: this window has no other purpose, so it goes away. */
const closeWindow = (): void => window.close();

/**
 * First-run onboarding and the Finder are separate windows. The main process opens the onboarding one with a
 * launch argument (`pending`), so it shows the flow and nothing else, and every other window is the Finder.
 * Onboarding's `load()` is authoritative and closes the window at once when the stored state says it is done.
 */
function Root(): ReactElement {
	return window.autorag.onboarding.pending ? <Onboarding onComplete={closeWindow} /> : <App />;
}

const container = document.getElementById("root");
if (container === null) {
	throw new Error("Renderer mount point #root not found");
}

// Render only once the window is in the stored interface language, so no screen paints in the Korean default first.
void applyInterfaceLanguage(window.autorag.settings).then(() => {
	createRoot(container).render(
		<StrictMode>
			<Root />
		</StrictMode>,
	);
});
