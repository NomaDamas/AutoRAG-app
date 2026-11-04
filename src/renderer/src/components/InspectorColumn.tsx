import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { PanelRightIcon } from "./icons";
import { iconButtonClass } from "./primitives/icon-button";

/**
 * The right sidebar: a full-height column beside the toolbar, mirroring the left
 * sidebar. Its head is a drag region as tall as the toolbar with the hide button
 * flush left, next to the content it gives room to; the toolbar's last button
 * brings the column back. The column keeps its width while the window grid
 * slides it to zero, so the content never reflows mid-animation.
 *
 * `children` (the Inspector) mount only while the column is shown: a hidden
 * inspector loads no file details.
 */
export function InspectorColumn({
	visible,
	width,
	onHide,
	children,
}: {
	readonly visible: boolean;
	readonly width: number;
	readonly onHide: () => void;
	readonly children: ReactNode;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="min-w-0 min-h-0 overflow-hidden" inert={!visible} aria-hidden={!visible}>
			<div className="inspector-column flex h-full flex-col bg-subtle border-l border-border" style={{ width }}>
				<div className="inspector-head flex flex-none items-center gap-8 h-toolbar px-12 [-webkit-app-region:drag]">
					<button
						type="button"
						className={cn(iconButtonClass({ size: "size-toolbar-icon", tone: "text-ink-muted" }), "[-webkit-app-region:no-drag]")}
						title={t("toolbar.hideInspector")}
						aria-label={t("toolbar.hideInspector")}
						onClick={onHide}
					>
						<PanelRightIcon size={18} />
					</button>
				</div>
				{visible ? children : null}
			</div>
		</div>
	);
}
