import "./lib/error-reporting";
import { StrictMode, useCallback, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import "../styles/app.css";
import { App } from "./App";
import { Onboarding } from "./onboarding/Onboarding";

/**
 * The first-run gate: show the onboarding flow while this window is pending,
 * then mount the Finder in the same window (no reload). `pending` is the
 * preload's read of the launch argument; onboarding's `load()` is authoritative
 * and completes immediately when the stored state says onboarding is done.
 */
function Root(): ReactElement {
	const [pending, setPending] = useState(() => window.autorag.onboarding.pending);
	const handleComplete = useCallback(() => setPending(false), []);
	return pending ? <Onboarding onComplete={handleComplete} /> : <App />;
}

const container = document.getElementById("root");
if (container === null) {
	throw new Error("Renderer mount point #root not found");
}

createRoot(container).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
