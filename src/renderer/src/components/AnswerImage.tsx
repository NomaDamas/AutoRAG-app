/**
 * An image referenced by an AI Search answer or evidence excerpt.
 *
 * A local image Chromium can decode renders as a picture, streamed through the
 * `autorag-preview://` protocol Quick Look already uses, and captioned with its
 * file name (full path on hover); clicking it opens Quick Look. Anything that
 * cannot be drawn — a missing or unreadable file, HEIC/TIFF, a relative link
 * with no document to resolve against — renders as a card that names the file
 * and shows its path, so the answer still says where the image is. Web images
 * are never fetched from model output; their card opens the page in the OS
 * browser.
 */

import { useEffect, useState, type ReactElement } from "react";
import { previewStreamUrl, type QuickLookTarget } from "../../../preview/shared/contract";
import { imageTarget, type InlineSegment } from "../state/answer-markdown";
import { ImageEditIcon, LinkIcon } from "./icons";

export interface ImageActions {
	/** Open a local image in Quick Look. */
	readonly onOpenImage: (target: QuickLookTarget) => void;
	/** Open a web image's page in the OS browser. */
	readonly onOpenUrl: (url: string) => void;
}

type ImageSegment = Extract<InlineSegment, { readonly kind: "image" }>;

/** The image segments of one parsed line, each reference once. */
export function lineImages(segments: readonly InlineSegment[]): readonly ImageSegment[] {
	const seen = new Set<string>();
	return segments.filter((segment): segment is ImageSegment => {
		if (segment.kind !== "image" || seen.has(segment.target)) return false;
		seen.add(segment.target);
		return true;
	});
}

/** The figures under a line of prose, or null when the line references no image. */
export function ImageRow({
	images,
	folder,
	actions,
}: {
	readonly images: readonly ImageSegment[];
	/** Folder of the document the text came from; resolves relative links. */
	readonly folder: string | null;
	readonly actions: ImageActions;
}): ReactElement | null {
	if (images.length === 0) return null;
	return (
		<div className="answer-images flex flex-wrap items-start gap-8">
			{images.map((image) => (
				<AnswerImage key={image.target} reference={image.target} alt={image.alt} folder={folder} actions={actions} />
			))}
		</div>
	);
}

const CARD =
	"answer-image-card flex w-full max-w-[420px] items-center gap-10 rounded-8 border border-border bg-window px-10 py-8 text-left";

export function AnswerImage({
	reference,
	alt,
	folder,
	actions,
}: {
	readonly reference: string;
	readonly alt: string;
	readonly folder: string | null;
	readonly actions: ImageActions;
}): ReactElement {
	const target = imageTarget(reference, folder);
	const [failed, setFailed] = useState(false);
	useEffect(() => setFailed(false), [reference, folder]);

	if (target.kind === "web") {
		return (
			<button
				type="button"
				data-image-url={target.url}
				className={`${CARD} cursor-pointer transition-colors duration-(--dur-color) ease-out hover:bg-hover-icon`}
				onClick={() => actions.onOpenUrl(target.url)}
			>
				<span className="grid size-28 flex-none place-items-center rounded-6 bg-accent-wash text-accent-text">
					<LinkIcon size={14} />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-caption font-semibold text-ink">{alt === "" ? "웹 이미지" : alt}</span>
					<span className="block truncate text-badge text-accent-text" title={target.url}>
						{target.url}
					</span>
				</span>
			</button>
		);
	}

	if (target.kind === "unresolved") {
		return (
			<div className={CARD}>
				<ImageGlyph />
				<span className="min-w-0 flex-1">
					<span className="block truncate text-caption font-semibold text-ink">{alt === "" ? "이미지" : alt}</span>
					<span className="block truncate font-mono text-badge text-ink-muted select-text" title={target.text}>
						{target.text}
					</span>
				</span>
			</div>
		);
	}

	const open = (): void => actions.onOpenImage({ path: target.path, name: target.name });
	const pathLine = (
		<span className="block truncate font-mono text-badge text-ink-muted select-text" title={target.path}>
			{target.path}
		</span>
	);

	if (target.renderable && !failed) {
		return (
			<figure data-image-path={target.path} className="answer-image m-0 flex max-w-full flex-col gap-4">
				<button
					type="button"
					aria-label={`${target.name} 훑어보기`}
					className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-8 border border-border bg-window p-0"
					onClick={open}
				>
					<img
						className="block max-h-[320px] max-w-full object-contain"
						src={previewStreamUrl(target.path)}
						alt={alt === "" ? target.name : alt}
						decoding="async"
						draggable={false}
						onError={() => setFailed(true)}
					/>
				</button>
				<figcaption className="min-w-0 max-w-[420px] text-badge text-ink-muted">
					<span className="block truncate" title={target.path}>
						{alt === "" ? target.name : `${alt} · ${target.name}`}
					</span>
				</figcaption>
			</figure>
		);
	}

	// Decodable but unreadable: the file is missing or broken, so Quick Look
	// has nothing to show either; the card only says where it was expected.
	if (failed) {
		return (
			<figure data-image-path={target.path} className={`${CARD} m-0`}>
				<ImageGlyph />
				<span className="min-w-0 flex-1">
					<span className="block truncate text-caption font-semibold text-ink">{target.name}</span>
					{pathLine}
					<span className="block text-badge text-ink-muted">이미지를 불러올 수 없습니다</span>
				</span>
			</figure>
		);
	}

	// A format Chromium cannot draw inline (HEIC, TIFF): Quick Look converts it.
	return (
		<figure data-image-path={target.path} className="m-0">
			<button type="button" className={`${CARD} cursor-pointer transition-colors duration-(--dur-color) ease-out hover:bg-hover-icon`} onClick={open}>
				<ImageGlyph />
				<span className="min-w-0 flex-1">
					<span className="block truncate text-caption font-semibold text-ink">{target.name}</span>
					{pathLine}
					<span className="block text-badge text-ink-muted">클릭하면 훑어보기로 엽니다</span>
				</span>
			</button>
		</figure>
	);
}

function ImageGlyph(): ReactElement {
	return (
		<span className="grid size-28 flex-none place-items-center rounded-6 bg-subtle text-ink-muted">
			<ImageEditIcon size={15} />
		</span>
	);
}
