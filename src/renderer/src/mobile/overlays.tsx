/**
 * What floats over a phone screen: the anchored menu (and the lifted row of a
 * long-press), sheets, the alert, and full-screen Quick Look. Each takes the
 * data it shows and callbacks; the shell owns the state.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check as CheckGlyph, ChevronRight, Download, Ellipsis, ExternalLink, House, Info, Music, Sparkles, Trash2, X } from "lucide-react";
import { locateLines } from "../../../preview/shared/text-marks";
import type { FinderEntry } from "../data/entries";
import { cn } from "../lib/cn";
import { previewKind } from "./model";
import { EntryName, GlassButton, GlassText, NavTitle, Thumb } from "./parts";

/* ------------------------------------------------------------------ Menu -- */

export interface MenuAnchor {
	/** CSS position inside the phone frame (`top`/`bottom`, `right`, `max-height`). */
	readonly style: React.CSSProperties;
	/** The lifted row of a long-press, drawn above the scrim. */
	readonly lift?: { readonly entry: FinderEntry; readonly top: number; readonly count: number; readonly previewUrl: string | null; readonly meta: ReactNode } | undefined;
}

export function MenuLayer({ anchor, label, onDismiss, children }: { readonly anchor: MenuAnchor; readonly label: string; readonly onDismiss: () => void; readonly children: ReactNode }): ReactElement {
	const menuRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onDismiss();
		};
		window.addEventListener("keydown", onKey);
		menuRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
		return () => window.removeEventListener("keydown", onKey);
	}, [onDismiss]);
	const lift = anchor.lift;
	return (
		<>
			<button type="button" className={cn("phone-scrim", lift === undefined ? "is-clear" : "is-blur")} aria-label={label} onClick={onDismiss} />
			{lift === undefined ? null : (
				<div className="phone-lift" style={{ top: lift.top }} aria-hidden="true">
					<Thumb entry={lift.entry} previewUrl={lift.previewUrl} />
					<div className="phone-row-main"><EntryName entry={lift.entry} />{lift.meta}</div>
					{lift.count > 1 ? <span className="phone-lift-count">{lift.count}</span> : null}
				</div>
			)}
			<div ref={menuRef} className="phone-menu" role="menu" aria-label={label} style={anchor.style}>
				{children}
			</div>
		</>
	);
}

export function MenuItem({ icon, label, hint, onClick, tone, checked = false, submenu, open = false, sub = false, testId }: {
	readonly icon?: ReactNode;
	readonly label: string;
	readonly hint?: string | undefined;
	readonly onClick: () => void;
	readonly tone?: "danger" | "accent" | undefined;
	readonly checked?: boolean;
	readonly submenu?: boolean;
	readonly open?: boolean;
	readonly sub?: boolean;
	readonly testId?: string;
}): ReactElement {
	return (
		<button
			type="button"
			role={checked ? "menuitemradio" : "menuitem"}
			aria-checked={checked ? true : undefined}
			aria-expanded={submenu === true ? open : undefined}
			className={cn("phone-mi", tone === "danger" && "is-danger", tone === "accent" && "is-accent", checked && "is-check", sub && "is-sub", open && "is-open")}
			onClick={onClick}
			data-testid={testId}
		>
			{checked ? <CheckGlyph size={18} strokeWidth={2.6} /> : icon === undefined ? <span className="phone-mi-icon" /> : icon}
			<span className="phone-mi-main">
				{label}
				{hint === undefined ? null : <small>{hint}</small>}
			</span>
			{submenu === true ? <ChevronRight className="phone-mi-tail" size={16} strokeWidth={2.4} aria-hidden="true" /> : null}
		</button>
	);
}

export function MenuSeparator(): ReactElement {
	return <div className="phone-menu-sep" role="separator" />;
}

export function MenuLabel({ children }: { readonly children: ReactNode }): ReactElement {
	return <div className="phone-menu-label">{children}</div>;
}

/* ----------------------------------------------------------------- Sheet -- */

export function Sheet({ title, subtitle, onClose, closeLabel, left, right, medium = false, solid = false, full = false, children, foot, testId }: {
	readonly title: string;
	readonly subtitle?: string | undefined;
	readonly onClose: () => void;
	readonly closeLabel: string;
	readonly left?: ReactNode;
	readonly right?: ReactNode;
	readonly medium?: boolean;
	readonly solid?: boolean;
	readonly full?: boolean;
	readonly children: ReactNode;
	readonly foot?: ReactNode;
	readonly testId?: string;
}): ReactElement {
	const [expanded, setExpanded] = useState(full);
	const [drag, setDrag] = useState<number | null>(null);
	const start = useRef<number | null>(null);
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	// The grabber and header drag the sheet: down past 110px closes it, an upward pull takes it to full height.
	const handlers = {
		onPointerDown: (event: React.PointerEvent) => {
			if ((event.target as HTMLElement).closest("button") !== null) return;
			start.current = event.clientY;
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		},
		onPointerMove: (event: React.PointerEvent) => {
			if (start.current !== null) setDrag(event.clientY - start.current);
		},
		onPointerUp: () => {
			const dy = drag ?? 0;
			start.current = null;
			setDrag(null);
			if (dy > 110) onClose();
			else if (dy < -40) setExpanded(true);
		},
	};
	return (
		<>
			<button type="button" className="phone-scrim" aria-label={closeLabel} onClick={onClose} />
			<div
				className={cn("phone-sheet", medium && !expanded && "is-medium", solid && "is-solid", expanded && "is-full", drag !== null && "is-dragging")}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				style={drag !== null && drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
				data-testid={testId}
			>
				<span className="phone-grabber" aria-hidden="true" {...handlers} />
				<div className="phone-sheet-head" {...handlers}>
					{left ?? (
						<GlassButton label={closeLabel} onClick={onClose}>
							<X size={20} strokeWidth={2.2} />
						</GlassButton>
					)}
					<h3>
						{title}
						{subtitle === undefined ? null : <small>{subtitle}</small>}
					</h3>
					{right ?? <span style={{ width: 44 }} />}
				</div>
				<div className="phone-sheet-body">{children}</div>
				{foot}
			</div>
		</>
	);
}

/* ----------------------------------------------------------------- Alert -- */

export function Alert({ title, text, input, okLabel, cancelLabel, danger = false, selectStem = false, onOk, onCancel }: {
	readonly title: string;
	readonly text?: string;
	readonly input?: string;
	readonly okLabel: string;
	readonly cancelLabel: string;
	readonly danger?: boolean;
	readonly selectStem?: boolean;
	readonly onOk: (value: string) => void;
	readonly onCancel: () => void;
}): ReactElement {
	const field = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(input ?? "");
	useEffect(() => {
		const node = field.current;
		if (node === null) return;
		node.focus();
		const dot = node.value.lastIndexOf(".");
		node.setSelectionRange(0, selectStem && dot > 0 ? dot : node.value.length);
	}, [selectStem]);
	return (
		<>
			<button type="button" className="phone-scrim" aria-label={cancelLabel} onClick={onCancel} />
			<div className="phone-alert" role="alertdialog" aria-modal="true" aria-label={title}>
				<h4>{title}</h4>
				{text === undefined ? null : <p>{text}</p>}
				{input === undefined ? null : (
					<input
						ref={field}
						value={value}
						autoComplete="off"
						spellCheck={false}
						enterKeyHint="done"
						aria-label={title}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") onOk(value);
							if (event.key === "Escape") onCancel();
						}}
					/>
				)}
				<div className="phone-alert-btns">
					<button type="button" onClick={onCancel}>{cancelLabel}</button>
					<button type="button" className={danger ? "is-danger" : "is-primary"} onClick={() => onOk(value)}>{okLabel}</button>
				</div>
			</div>
		</>
	);
}

/* ------------------------------------------------------------ Quick Look -- */

export function QuickLook({ entries, index, previewUrl, onIndex, onClose, onInfo, onDownload, onAsk, onMore, onTrash, anchor = null }: {
	readonly entries: readonly FinderEntry[];
	readonly index: number;
	readonly previewUrl: (entry: FinderEntry) => string | null;
	readonly onIndex: (index: number) => void;
	readonly onClose: () => void;
	readonly onInfo: (entry: FinderEntry) => void;
	readonly onDownload: (entry: FinderEntry) => void;
	readonly onAsk: (entry: FinderEntry) => void;
	readonly onMore: (entry: FinderEntry, anchor: HTMLElement) => void;
	readonly onTrash: (entry: FinderEntry) => void;
	/** Evidence excerpts (an AI Search citation): a text file marks and scrolls to the first one it finds. */
	readonly anchor?: readonly string[] | null | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const [immersive, setImmersive] = useState(false);
	const [dx, setDx] = useState<number | null>(null);
	const [dy, setDy] = useState(0);
	const start = useRef<{ x: number; y: number; axis: "x" | "y" | null } | null>(null);
	const entry = entries[index];
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
			if (event.key === "ArrowRight" && index < entries.length - 1) onIndex(index + 1);
			if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [entries.length, index, onClose, onIndex]);
	if (entry === undefined) return <></>;
	const paper = previewKind(entry) === "pdf" || previewKind(entry) === "text" || previewKind(entry) === null || previewKind(entry) === "audio";
	return (
		<div
			className={cn("phone-ql", paper && "is-paper", immersive && "is-immersive")}
			role="dialog"
			aria-modal="true"
			aria-label={entry.name}
			style={dy > 0 ? { transform: `translateY(${dy * 0.6}px) scale(${1 - Math.min(dy, 300) / 1500})`, opacity: 1 - Math.min(dy, 300) / 600 } : undefined}
			data-testid="phone-quicklook"
		>
			<div className="phone-ql-top">
				<GlassText onClick={onClose}>{t("mobile.ql.done")}</GlassText>
				<NavTitle always title={entry.name} subtitle={t("mobile.ql.position", { index: index + 1, total: entries.length })} />
				<span className="phone-spacer" />
				<GlassButton label={t("mobile.info.title")} onClick={() => onInfo(entry)}><Info size={20} strokeWidth={2.1} /></GlassButton>
			</div>
			<div
				className="phone-ql-stage"
				onPointerDown={(event) => {
					if ((event.target as HTMLElement).closest("button, video, audio, iframe, .phone-ql-text") !== null) return;
					start.current = { x: event.clientX, y: event.clientY, axis: null };
				}}
				onPointerMove={(event) => {
					const s = start.current;
					if (s === null) return;
					const mx = event.clientX - s.x;
					const my = event.clientY - s.y;
					if (s.axis === null && Math.hypot(mx, my) > 8) s.axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
					if (s.axis === "x") setDx(mx);
					if (s.axis === "y") setDy(Math.max(0, my));
				}}
				onPointerUp={() => {
					const s = start.current;
					start.current = null;
					if (s?.axis === "x" && dx !== null) {
						if (dx < -60 && index < entries.length - 1) onIndex(index + 1);
						else if (dx > 60 && index > 0) onIndex(index - 1);
					} else if (s?.axis === "y") {
						if (dy > 120) onClose();
					} else if (s !== null) setImmersive((value) => !value);
					setDx(null);
					setDy(0);
				}}
			>
				<div className={cn("phone-ql-track", dx !== null && "is-dragging")} style={{ transform: `translateX(calc(${-index * 100}% + ${dx ?? 0}px))` }}>
					{entries.map((item, position) => (
						<div key={item.path} className="phone-ql-slide">
							{Math.abs(position - index) <= 1 ? <QuickLookContent entry={item} url={previewUrl(item)} active={position === index} anchor={position === index ? anchor : null} onDownload={() => onDownload(item)} /> : null}
						</div>
					))}
				</div>
			</div>
			<div className="phone-ql-bottom">
				<div className="phone-ggroup phone-glass">
					<button type="button" className="phone-gbtn" aria-label={t("mobile.menu.download")} onClick={() => onDownload(entry)}><Download size={22} strokeWidth={2} /></button>
					{previewUrl(entry) === null ? null : (
						<button type="button" className="phone-gbtn" aria-label={t("mobile.ql.openTab")} title={t("mobile.ql.openTab")} data-testid="phone-ql-open-tab" onClick={() => openInTab(previewUrl(entry))}><ExternalLink size={22} strokeWidth={2} /></button>
					)}
					<button type="button" className="phone-gbtn" aria-label={t("mobile.menu.askOne")} onClick={() => onAsk(entry)}><Sparkles size={22} strokeWidth={2} /></button>
					<button type="button" className="phone-gbtn" aria-label={t("mobile.more")} onClick={(event) => onMore(entry, event.currentTarget)}><Ellipsis size={22} strokeWidth={2} /></button>
					<button type="button" className="phone-gbtn" aria-label={t("mobile.select.trash")} onClick={() => onTrash(entry)}><Trash2 size={22} strokeWidth={2} /></button>
				</div>
			</div>
		</div>
	);
}

/** The browser's own viewer in a new tab: a phone's PDF reader, zoom and share sheet beat anything framed. */
function openInTab(url: string | null): void {
	if (url !== null) window.open(url, "_blank", "noopener");
}

/**
 * A text file drawn as lines, the cited lines marked and scrolled into view
 * (the desktop Quick Look's `locateLines`). A framed `text/plain` page has no
 * marks and renders in the browser's tiny monospace default.
 */
function TextPreview({ url, anchor }: { readonly url: string; readonly anchor: readonly string[] | null }): ReactElement {
	const { t } = useTranslation();
	const [text, setText] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const firstMark = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let live = true;
		fetch(url)
			.then(async (response) => {
				if (!response.ok) throw new Error(String(response.status));
				const body = await response.text();
				if (live) setText(body);
			})
			.catch(() => {
				if (live) setFailed(true);
			});
		return () => {
			live = false;
		};
	}, [url]);
	const marked = useMemo(() => (text === null || anchor === null ? new Set<number>() : locateLines(text, anchor)), [anchor, text]);
	useEffect(() => {
		firstMark.current?.scrollIntoView({ block: "center" });
	}, [marked]);
	if (failed) return <div className="phone-ql-none"><span>{t("mobile.ql.noPreview")}</span></div>;
	if (text === null) return <div className="phone-ql-none"><span>{t("mobile.loading")}</span></div>;
	const first = marked.size === 0 ? -1 : Math.min(...marked);
	return (
		<div className="phone-ql-text phone-selectable" data-testid="phone-ql-text">
			{text.split("\n").map((line, number) => (
				<div key={number} ref={number === first ? firstMark : undefined} className={cn("phone-ql-line", marked.has(number) && "is-mark")}>
					{line.length === 0 ? "\u00a0" : line}
				</div>
			))}
		</div>
	);
}

function QuickLookContent({ entry, url, active, anchor, onDownload }: { readonly entry: FinderEntry; readonly url: string | null; readonly active: boolean; readonly anchor: readonly string[] | null | undefined; readonly onDownload: () => void }): ReactElement {
	const { t } = useTranslation();
	const kind = previewKind(entry);
	if (url !== null && kind === "image") return <img src={url} alt={entry.name} draggable={false} />;
	if (url !== null && kind === "video") return <video src={url} controls playsInline preload={active ? "metadata" : "none"} />;
	if (url !== null && kind === "text") return active ? <TextPreview url={url} anchor={anchor ?? null} /> : <></>;
	if (url !== null && kind === "audio") {
		return (
			<div className="phone-ql-audio">
				<div className="phone-ql-art"><Music size={72} strokeWidth={1.6} /></div>
				<h5>{entry.name}</h5>
				<audio src={url} controls preload={active ? "metadata" : "none"} />
			</div>
		);
	}
	if (url !== null && kind === "pdf") return active ? <iframe title={entry.name} src={url} /> : <></>;
	return (
		<div className="phone-ql-none">
			<Thumb entry={entry} previewUrl={null} large />
			<b>{entry.name}</b>
			<span>{t("mobile.ql.noPreview")}</span>
			<button type="button" className="phone-big-btn" onClick={onDownload}>{t("mobile.menu.download")}</button>
		</div>
	);
}

/* ---------------------------------------------------------- Picker crumbs -- */

export function Crumbs({ trail, onPick, homeLabel }: { readonly trail: readonly { readonly path: string; readonly label: string }[]; readonly onPick: (path: string | null) => void; readonly homeLabel: string }): ReactElement {
	const ref = useRef<HTMLElement>(null);
	const current = trail.at(-1)?.path;
	// A deep path is wider than the sheet: keep the folder you are in, the last crumb, in view.
	useEffect(() => {
		const nav = ref.current;
		if (nav !== null) nav.scrollLeft = nav.scrollWidth;
	}, [current]);
	return (
		<nav ref={ref} className="phone-crumbs" aria-label={homeLabel}>
			<button type="button" aria-label={homeLabel} onClick={() => onPick(null)}><House size={16} strokeWidth={2.2} /></button>
			{trail.map((crumb, index) => (
				<span key={crumb.path} style={{ display: "contents" }}>
					<ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />
					<button type="button" aria-current={index === trail.length - 1 ? "true" : undefined} onClick={() => onPick(crumb.path)}>{crumb.label}</button>
				</span>
			))}
		</nav>
	);
}
