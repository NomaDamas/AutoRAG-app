import type { ReactElement } from "react";

export function CloseIcon(): ReactElement {
	return (
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
			<path d="M2 2l8 8M10 2L2 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
		</svg>
	);
}

export function FullscreenIcon(): ReactElement {
	return (
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
			<path d="M7 1.5h3.5V5M5 10.5H1.5V7M10.5 1.5L7 5M1.5 10.5L5 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

export function OpenIcon(): ReactElement {
	return (
		<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
			<path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v7A1.5 1.5 0 0 0 3.5 12h7A1.5 1.5 0 0 0 12 10.5V8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
			<path d="M8 2h4v4M12 2L6.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}
