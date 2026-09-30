import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type TransitionEvent } from "react";
import type { PreviewDocument } from "../shared/contract";
import { describeExtension } from "../shared/registry";
import { extensionOf, formatBytes } from "../shared/format";
import { viewerForExtension, wantsBytes } from "../shared/registry";
import { stepQuickLook, type QuickLookPhase, type QuickLookRequest } from "../shared/session";
import { zoomFromAnchor } from "../shared/zoom";
import { LoadingBody, PreviewBody } from "./body";
import { CloseIcon, OpenIcon } from "./icons";
import { readPreviewDocument } from "./read";
import "./quick-look.css";

type BodyState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly document: PreviewDocument };

export function QuickLookHost({
	target,
	onOpenFile,
	onClose,
}: {
	readonly target: QuickLookRequest | null;
	readonly onOpenFile: (path: string) => void;
	readonly onClose: () => void;
}): ReactElement | null {
	const [shown, setShown] = useState<QuickLookRequest | null>(null);
	const [phase, setPhase] = useState<QuickLookPhase>("closed");
	const [body, setBody] = useState<BodyState>({ status: "loading" });
	const panelRef = useRef<HTMLDivElement | null>(null);
	const next = stepQuickLook(target, shown, phase);
	if (next.shown !== shown) setShown(next.shown);
	if (next.phase !== phase) setPhase(next.phase);

	useEffect(() => {
		if (shown === null) return;
		const path = shown.path;
		let cancelled = false;
		setBody({ status: "loading" });
		readPreviewDocument(path, wantsBytes(viewerForExtension(extensionOf(shown.name))))
			.then((document) => {
				if (!cancelled) setBody({ status: "ready", document });
			})
			.catch((caught: unknown) => {
				if (!cancelled) setBody({ status: "error", message: caught instanceof Error ? caught.message : String(caught) });
			});
		return () => {
			cancelled = true;
		};
	}, [shown]);

	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (panel === null || shown === null) return;
		if (phase !== "opening" && phase !== "closing") return;
		const dest = panel.getBoundingClientRect();
		const anchor = shown.anchor;
		const from =
			anchor === null
				? { x: dest.x + dest.width * 0.08, y: dest.y + dest.height * 0.08, width: dest.width * 0.84, height: dest.height * 0.84 }
				: anchor;
		const zoom = zoomFromAnchor(from, dest);
		const start = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
		const end = "translate(0px, 0px) scale(1)";
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (anchor !== null) {
			panel.dataset.originX = String(Math.round(anchor.x + anchor.width / 2));
			panel.dataset.originY = String(Math.round(anchor.y + anchor.height / 2));
		}
		panel.dataset.quicklookState = phase;
		if (phase === "opening") {
			panel.style.transition = "none";
			panel.style.transform = reduced ? end : start;
			panel.style.opacity = "0.4";
			const frame = requestAnimationFrame(() => {
				panel.style.transition = reduced
					? "opacity 120ms linear"
					: "transform var(--ql-open) var(--ql-ease), opacity 160ms ease-out";
				panel.style.transform = end;
				panel.style.opacity = "1";
			});
			return () => cancelAnimationFrame(frame);
		}
		panel.style.transition = reduced ? "opacity 120ms linear" : "transform 220ms ease-in, opacity 140ms ease-in";
		panel.style.transform = reduced ? end : start;
		panel.style.opacity = "0";
		return undefined;
	}, [phase, shown]);

	if (shown === null) return null;
	const ready = body.status === "ready" ? body.document : null;
	const meta =
		ready === null
			? describeExtension(extensionOf(shown.name))
			: `${describeExtension(ready.ext)} · ${formatBytes(ready.size)}`;

	function onTransitionEnd(event: TransitionEvent<HTMLDivElement>): void {
		if (event.target !== event.currentTarget) return;
		if (event.propertyName !== "transform" && event.propertyName !== "opacity") return;
		setPhase((current) => {
			if (current === "opening") return "open";
			if (current === "closing") return "closed";
			return current;
		});
	}

	return (
		<div className="ql" data-quicklook-root="" onClick={onClose}>
			<div
				ref={panelRef}
				className="ql__panel"
				role="dialog"
				aria-modal="true"
				aria-label={shown.name}
				data-quicklook-state={phase}
				onClick={(event) => event.stopPropagation()}
				onTransitionEnd={onTransitionEnd}
			>
				<header className="ql__header">
					<button type="button" className="ql__iconbtn" aria-label="닫기" onClick={onClose}>
						<CloseIcon />
					</button>
					<div className="ql__titles">
						<div className="ql__name">{shown.name}</div>
						<div className="ql__meta">{meta}</div>
					</div>
					<button type="button" className="ql__iconbtn" aria-label="기본 앱으로 열기" onClick={() => onOpenFile(shown.path)}>
						<OpenIcon />
					</button>
				</header>
				<div className="ql__stage">
					{body.status === "loading" ? <LoadingBody /> : null}
					{body.status === "error" ? <p className="ql__status">{body.message}</p> : null}
					{body.status === "ready" ? <PreviewBody file={body.document} /> : null}
				</div>
			</div>
		</div>
	);
}
