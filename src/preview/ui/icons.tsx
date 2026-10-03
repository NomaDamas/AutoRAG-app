import type { ReactElement } from "react";

/* Glyphs drawn from the Quick Look reference prototypes. Filled toolbar glyphs
 * knock their mark out with `--ql-knockout`, so they read on either material. */

export function CloseIcon(): ReactElement {
	return (
		<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
			<circle cx="10" cy="10" r="8.5" fill="currentColor" />
			<path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" style={{ stroke: "var(--ql-knockout)" }} strokeWidth="1.6" strokeLinecap="round" fill="none" />
		</svg>
	);
}

export function FullscreenIcon(): ReactElement {
	return (
		<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
			<circle cx="10" cy="10" r="8.5" fill="currentColor" />
			<path
				d="M8.8 6.3H6.3v2.5M6.3 6.3l3.2 3.2M11.2 13.7h2.5v-2.5M13.7 13.7l-3.2-3.2"
				style={{ stroke: "var(--ql-knockout)" }}
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
				fill="none"
			/>
		</svg>
	);
}

export function ShareIcon(): ReactElement {
	return (
		<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M10 12V2.8M6.9 5.6L10 2.6l3.1 3" />
			<path d="M7.2 8.2H5.6a1 1 0 0 0-1 1v7.2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1V9.2a1 1 0 0 0-1-1h-1.6" />
		</svg>
	);
}

export function WrapIcon(): ReactElement {
	return (
		<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4" />
			<path d="M15 16l-2 2 2 2" />
			<path d="M4 18h5" />
		</svg>
	);
}

export function CopyIcon(): ReactElement {
	return (
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<rect x="8" y="8" width="12" height="12" rx="2" />
			<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
		</svg>
	);
}

export function DesktopIcon(): ReactElement {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
			<rect x="3" y="4" width="18" height="12" rx="1.5" />
			<path d="M9 20h6M12 16v4" />
		</svg>
	);
}

export function MobileIcon(): ReactElement {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
			<rect x="7" y="3" width="10" height="18" rx="2" />
			<path d="M11 18h2" />
		</svg>
	);
}

export function SourceIcon(): ReactElement {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
		</svg>
	);
}

export function SpeakerIcon({ size, muted }: { readonly size: number; readonly muted: boolean }): ReactElement {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
			<path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4z" fill="currentColor" />
			{muted ? (
				<path d="M15.5 9.5l5 5M20.5 9.5l-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
			) : (
				<path d="M15 9.2a4 4 0 0 1 0 5.6M17.6 6.8a7.5 7.5 0 0 1 0 10.4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
			)}
		</svg>
	);
}

export function SkipIcon({ direction }: { readonly direction: "back" | "forward" }): ReactElement {
	const back = direction === "back";
	return (
		<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d={back ? "M4.5 12a7.5 7.5 0 1 0 2.4-5.5" : "M19.5 12a7.5 7.5 0 1 1-2.4-5.5"} />
			<path d={back ? "M6.6 3.4v3.6h3.6" : "M17.4 3.4v3.6h-3.6"} />
			<text x={back ? 12.4 : 11.6} y="15.4" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="-apple-system, 'Segoe UI', Helvetica, sans-serif">
				15
			</text>
		</svg>
	);
}

export function PlayIcon({ size }: { readonly size: number }): ReactElement {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M7 4.5v15l12.5-7.5z" />
		</svg>
	);
}

export function PauseIcon({ size }: { readonly size: number }): ReactElement {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<rect x="6" y="4.5" width="4" height="15" rx="1" />
			<rect x="14" y="4.5" width="4" height="15" rx="1" />
		</svg>
	);
}

export function LoopIcon({ size, weight }: { readonly size: number; readonly weight: number }): ReactElement {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M4.5 11V9.5A2.5 2.5 0 0 1 7 7h12.5" />
			<path d="M16.5 4l3 3-3 3" />
			<path d="M19.5 13v1.5A2.5 2.5 0 0 1 17 17H4.5" />
			<path d="M7.5 20l-3-3 3-3" />
		</svg>
	);
}

export function PictureInPictureIcon(): ReactElement {
	return (
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
			<rect x="3" y="5" width="18" height="14" rx="2.5" />
			<rect x="12" y="11.5" width="6.5" height="5" rx="1" fill="currentColor" stroke="none" />
		</svg>
	);
}

export function ContinueIcon(): ReactElement {
	return (
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M5 6l6 6-6 6M12 6l6 6-6 6" />
		</svg>
	);
}

export function ChevronIcon({ open }: { readonly open: boolean }): ReactElement {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className="transition-transform duration-200"
			style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
		>
			<path d="M9 6l6 6-6 6" />
		</svg>
	);
}

/** The large page glyph of the "Other" panel, labelled with the file's extension. */
export function FileGlyph({ label }: { readonly label: string }): ReactElement {
	return (
		<svg width="176" height="214" viewBox="0 0 176 214" aria-hidden="true" className="flex-none [filter:drop-shadow(0_3px_6px_rgba(0,0,0,0.18))]">
			<path d="M12 4h108l52 52v148a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6z" fill="#fbfbfb" stroke="#d5d5d8" strokeWidth="1" />
			<path d="M120 4v44a8 8 0 0 0 8 8h44" fill="#ececee" stroke="#d5d5d8" strokeWidth="1" />
			<path d="M30 130c30-40 70-48 120-30M30 150c34-34 74-36 120-14M30 170c40-26 78-22 120 0" fill="none" stroke="#e6e6e9" strokeWidth="2" />
			<rect x="26" y="10" width="13" height="8" fill="#2b2b2e" />
			<rect x="39" y="22" width="13" height="8" fill="#2b2b2e" />
			<rect x="26" y="34" width="13" height="8" fill="#2b2b2e" />
			<rect x="39" y="46" width="13" height="8" fill="#2b2b2e" />
			<rect x="26" y="58" width="13" height="8" fill="#2b2b2e" />
			<rect x="33" y="70" width="12" height="16" rx="2" fill="#2b2b2e" />
			<text x="89" y="194" textAnchor="middle" fontFamily="-apple-system, 'Helvetica Neue', 'Segoe UI', sans-serif" fontSize="26" fontWeight="700" fill="#5a5a5e">
				{label}
			</text>
		</svg>
	);
}

/** The large folder glyph of the folder panel. */
export function FolderGlyph(): ReactElement {
	return (
		<svg width="176" height="142" viewBox="0 0 176 142" aria-hidden="true" className="flex-none [filter:drop-shadow(0_3px_6px_rgba(0,0,0,0.16))]">
			<path d="M6 16a10 10 0 0 1 10-10h46a10 10 0 0 1 7.4 3.3l8.2 9.2h82.4a10 10 0 0 1 10 10V126a10 10 0 0 1-10 10H16a10 10 0 0 1-10-10z" fill="#3f97ec" />
			<path d="M6 40a10 10 0 0 1 10-10h144a10 10 0 0 1 10 10v86a10 10 0 0 1-10 10H16a10 10 0 0 1-10-10z" fill="#6fb7f7" />
			<path d="M6 40a10 10 0 0 1 10-10h144a10 10 0 0 1 10 10v3H6z" fill="#8cc7fa" />
		</svg>
	);
}

/** A child folder in the folder panel's item grid. */
export function SmallFolderGlyph(): ReactElement {
	return (
		<svg width="44" height="36" viewBox="0 0 44 36" aria-hidden="true">
			<path d="M2 5a3 3 0 0 1 3-3h11l3.5 3.5H39a3 3 0 0 1 3 3V31a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" fill="#3f97ec" />
			<path d="M2 11a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" fill="#6fb7f7" />
		</svg>
	);
}
