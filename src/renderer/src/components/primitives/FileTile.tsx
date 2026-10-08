import { useEffect, useState, type ReactElement } from "react";
import { type FileKind, kindMeta } from "../../state/kinds";

const TILE_BASE = "flex-none items-center justify-center text-on-tile font-bold";

/** v7 `fileIcon('folder')` — the two-path Bloom folder (back + front lid). */
const FOLDER_BACK = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const FOLDER_FRONT = "M3 9h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";

function tileSizeClass(size: 16 | 18 | 22): string {
	switch (size) {
		case 16:
			return "size-16 rounded-4 text-tile";
		case 18:
			return "size-18 rounded-5 text-tile";
		case 22:
			return "size-22 rounded-6 text-badge";
	}
}

function FolderTile({ size, large }: { readonly size: number; readonly large: boolean }): ReactElement {
	return (
		<svg
			className="tile tile--folder flex-none"
			width={large ? 70 : size}
			height={large ? 58 : size}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
		>
			<path d={FOLDER_BACK} fill="var(--folder)" stroke="var(--folder-stroke)" strokeWidth="0.7" />
			<path d={FOLDER_FRONT} fill="var(--folder-front)" />
		</svg>
	);
}

/** v7 `.doc-icon.doc-large`: a white sheet with a folded corner and a colored
 * letter strip across the bottom. */
function DocLargeTile({ kind }: { readonly kind: FileKind }): ReactElement {
	const meta = kindMeta(kind);
	return (
		<span
			className="tile tile--large doc-large relative block flex-none w-[52px] h-[64px] rounded-4 border border-border-strong bg-window shadow-[0_1px_1px_rgba(0,0,0,0.06)]"
			aria-hidden="true"
		>
			<span className="absolute -top-px -right-px border-l-[14px] border-t-[14px] border-l-divider border-t-window" />
			<span
				className="absolute left-[6px] right-[6px] bottom-8 h-18 rounded-3 text-meta font-extrabold leading-[18px] text-center text-on-tile"
				style={{ background: `var(${meta.tileToken})` }}
			>
				{meta.letter}
			</span>
		</span>
	);
}

/**
 * File-type tile (DESIGN.md §5 FileTile): rounded square, white letter, color
 * from the KD map. Folders render the v7 two-path folder glyph; the large
 * variant renders the reference's `.doc-icon.doc-large` sheet. When the OS
 * produced a tile icon (a Finder thumbnail), it renders inside the same box.
 */
export function FileTile({
	kind,
	iconUrl,
	size = 18,
	large = false,
}: {
	readonly kind: FileKind;
	readonly iconUrl?: string | null | undefined;
	readonly size?: 16 | 18 | 22;
	readonly large?: boolean;
}): ReactElement {
	const [failed, setFailed] = useState(false);
	useEffect(() => setFailed(false), [iconUrl]);
	if (kind === "folder") {
		return <FolderTile size={size} large={large} />;
	}
	if (iconUrl !== undefined && iconUrl !== null && !failed) {
		return (
			<img
				className={`tile tile--image flex-none block object-contain ${large ? "size-64" : tileSizeClass(size)} rounded-4`}
				crossOrigin="anonymous"
				src={iconUrl}
				alt=""
				loading="lazy"
				decoding="async"
				aria-hidden="true"
				draggable={false}
				onError={() => setFailed(true)}
			/>
		);
	}
	if (large) {
		return <DocLargeTile kind={kind} />;
	}
	const meta = kindMeta(kind);
	return (
		<span
			className={`tile tile--${size} flex ${TILE_BASE} ${tileSizeClass(size)}`}
			style={{ background: `var(${meta.tileToken})`, color: `var(${meta.foregroundToken})` }}
			aria-hidden="true"
		>
			{meta.letter}
		</span>
	);
}
