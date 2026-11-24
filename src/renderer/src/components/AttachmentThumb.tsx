/**
 * The picture of an image attachment: what a pasted screenshot (or a dropped or selected image file) looks like in a
 * composer and in the sent message, instead of a file name. In a composer it carries a round ✕ in its corner that takes
 * the attachment off; in the conversation it is the picture alone. An image the page cannot draw falls back to the
 * attachment's ordinary chip, so nothing is ever shown as a broken picture.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { previewStreamUrl } from "../../../preview/shared/contract";
import type { ChatAttachment } from "../../../shared/search-contract";
import { cn } from "../lib/cn";
import { isThumbnailAttachment } from "../state/attachments";
import { CloseIcon } from "./icons";

export type AttachmentThumbSize = "composer" | "compact" | "message";

const BOX: Readonly<Record<AttachmentThumbSize, string>> = {
	composer: "size-72 rounded-10",
	compact: "size-56 rounded-8",
	message: "max-h-[220px] max-w-full rounded-12",
};

export function AttachmentThumb({
	att,
	size,
	removeLabel,
	onRemove,
	fallback,
}: {
	readonly att: ChatAttachment;
	readonly size: AttachmentThumbSize;
	/** Accessible name of the ✕; required with `onRemove`. */
	readonly removeLabel?: string;
	readonly onRemove?: () => void;
	/** What shows when the picture cannot be drawn, or when the attachment is not a picture at all. */
	readonly fallback: ReactNode;
}): ReactElement {
	const [failed, setFailed] = useState(false);
	useEffect(() => setFailed(false), [att.id]);
	if (failed || !isThumbnailAttachment(att)) return <>{fallback}</>;
	return (
		<span className={cn("attachment-thumb relative inline-flex flex-none", size === "message" ? "max-w-[min(260px,100%)]" : "max-w-full")} data-attachment-thumb={att.id} title={att.name}>
			<img
				src={previewStreamUrl(att.id)}
				alt={att.name}
				draggable={false}
				onError={() => setFailed(true)}
				className={cn("block border border-divider bg-hover object-cover", BOX[size], size === "message" && "h-auto w-auto")}
			/>
			{onRemove === undefined ? null : (
				<button
					type="button"
					className="absolute -top-6 -right-6 flex size-18 cursor-pointer items-center justify-center rounded-full border border-border-strong bg-window p-0 text-ink shadow-[0_1px_3px_rgba(20,20,41,0.25)] hover:bg-hover-strong"
					aria-label={removeLabel}
					title={removeLabel}
					onClick={onRemove}
				>
					<CloseIcon size={9} />
				</button>
			)}
		</span>
	);
}
