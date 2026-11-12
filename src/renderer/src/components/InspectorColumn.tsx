import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { InspectorToggleIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";

/**
 * The right sidebar: a full-height column beside the toolbar, mirroring the left
 * sidebar. Its head is a drag region as tall as the toolbar, on the window's own
 * white, with the Dazzi mark as the hide button flush left (Figma 328:3991); on
 * Windows and Linux the window's own buttons sit at its right end. The toolbar's
 * last button, the same mark, brings the column back. The column keeps its width while the window grid
 * slides it to zero, so the content never reflows mid-animation.
 *
 * `children` (the Inspector) mount only while the column is shown: a hidden
 * inspector loads no file details.
 */
export function InspectorColumn({
	visible,
	width,
	onHide,
	surface = "subtle",
	children,
}: {
	readonly visible: boolean;
	readonly width: number;
	readonly onHide: () => void;
	/** "window" when the column hosts a chat on the window's own background, so the head above it is the same colour. */
	readonly surface?: "subtle" | "window";
	readonly children: ReactNode;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="min-w-0 min-h-0 overflow-hidden" inert={!visible} aria-hidden={!visible}>
			<div className={cn("inspector-column flex h-full flex-col border-l border-border", surface === "window" ? "bg-window" : "bg-subtle")} style={{ width }}>
				<div className="inspector-head flex flex-none items-center gap-8 h-toolbar bg-window px-12 [-webkit-app-region:drag]">
					<button
						type="button"
						className={cn(iconButtonClass({ size: "size-toolbar-icon", tone: "text-ink-body" }), "[-webkit-app-region:no-drag]")}
						title={t("toolbar.hideInspector")}
						aria-label={t("toolbar.hideInspector")}
						onClick={onHide}
					>
						<InspectorToggleIcon open />
					</button>
				</div>
				{visible ? children : null}
			</div>
		</div>
	);
}
