import type { ReactElement } from "react";

/** The arrow pointer coach marks animate over the real Finder. */
export function CursorGlyph(): ReactElement {
	return (
		<svg className="fr-cursor-glyph" width={26} height={26} viewBox="0 0 26 26" fill="none">
			<path d="M5.2 2.8L20.6 14.3L13.4 15.6L16.7 22.7L13.5 24.2L10.2 17.1L5.2 21.6V2.8Z" fill="#FFFFFF" stroke="#18191D" strokeWidth="1.7" strokeLinejoin="round" />
		</svg>
	);
}
