/**
 * Shared pieces for the prototype-aligned Settings pages
 * (`docs/prototypes/settings`): page head, sections, `linear-row` rows,
 * chips, list rows, app icons, floating menus and modals.
 *
 * The row markup stays `linear-*` (the shipped Settings visual language the
 * prototype is derived from) so QA selectors keep working; everything the
 * prototype adds is namespaced `settings-*` and scoped to `.settings-view` in
 * settings.css.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

export function SettingsPageHead({ title, description }: { readonly title: string; readonly description: string }): ReactElement {
	return (
		<div className="settings-page-head">
			<h1 className="linear-title">{title}</h1>
			<p className="linear-desc">{description}</p>
		</div>
	);
}

export function Section({ title, description, children }: { readonly title: string; readonly description?: string; readonly children: ReactNode }): ReactElement {
	return (
		<section className="settings-section">
			<div className="linear-section-title">{title}</div>
			{description !== undefined ? <p className="linear-section-desc">{description}</p> : null}
			{children}
		</section>
	);
}

export function Row({ name, hint, children, stack = false }: { readonly name: string; readonly hint: string; readonly children?: ReactNode; readonly stack?: boolean }): ReactElement {
	return (
		<div className={`linear-row${stack ? " is-stack" : ""}`}>
			<div className="linear-row-label">
				<span className="linear-row-name">{name}</span>
				<small>{hint}</small>
			</div>
			<div className="linear-control">{children}</div>
		</div>
	);
}

export function Note({ children }: { readonly children: ReactNode }): ReactElement {
	return (
		<p className="settings-note">
			<svg aria-hidden="true" focusable="false" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
				<circle cx="12" cy="12" r="10" />
				<path d="M12 16v-4" />
				<path d="M12 8h.01" />
			</svg>
			<span>{children}</span>
		</p>
	);
}

/** Neutral app glyph: the first letter of a provider/template label. */
export function AppIcon({ label, small = false }: { readonly label: string; readonly small?: boolean }): ReactElement {
	const letter = (label.trim().slice(0, 1) || "·").toUpperCase();
	return <span className={`settings-app-icon${small ? " is-sm" : ""}`} aria-hidden="true">{letter}</span>;
}

export function StatusDot({ tone }: { readonly tone: "ok" | "warn" | "run" | "off" }): ReactElement {
	const cls = tone === "off" ? "" : ` is-${tone}`;
	return <span className={`settings-dot${cls}`} aria-hidden="true" />;
}

export function Chips({
	items,
	onRemove,
	onAdd,
	addLabel,
}: {
	readonly items: readonly string[];
	readonly onRemove?: (index: number) => void;
	readonly onAdd?: () => void;
	readonly addLabel?: string;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="settings-chips">
			{items.map((item, index) => (
				<span className="settings-chip" key={`${item}-${index}`}>
					{item}
					{onRemove !== undefined ? (
						<button type="button" aria-label={t("settingsCore.chips.remove", { item })} onClick={() => onRemove(index)}>
							<X size={11} aria-hidden="true" focusable="false" />
						</button>
					) : null}
				</span>
			))}
			{onAdd !== undefined ? (
				<button type="button" className="settings-chip-add" onClick={onAdd}>
					{addLabel ?? t("settingsCore.chips.add")}
				</button>
			) : null}
		</div>
	);
}

/** A menu pinned to its trigger, flipped above and clamped to the viewport. */
export function FloatingMenu({
	anchor,
	compact = false,
	onClose,
	children,
}: {
	readonly anchor: HTMLElement;
	readonly compact?: boolean;
	readonly onClose: () => void;
	readonly children: ReactNode;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	const place = useCallback((): void => {
		const element = ref.current;
		if (element === null) return;
		const box = anchor.getBoundingClientRect();
		const width = element.offsetWidth;
		const height = element.offsetHeight;
		const startAligned = anchor.dataset.menuAlign === "start";
		const preferredLeft = startAligned ? box.left - 8 : box.right - width;
		const left = Math.max(12, Math.min(preferredLeft, window.innerWidth - width - 12));
		const below = box.bottom + 6;
		const top = below + height > window.innerHeight - 12 ? Math.max(12, box.top - 6 - height) : below;
		setPosition({ left, top });
	}, [anchor]);
	useLayoutEffect(() => {
		place();
	}, [place]);
	useEffect(() => {
		const onScroll = (): void => place();
		window.addEventListener("resize", onScroll);
		document.addEventListener("scroll", onScroll, true);
		return () => {
			window.removeEventListener("resize", onScroll);
			document.removeEventListener("scroll", onScroll, true);
		};
	}, [place]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		const onDown = (event: MouseEvent): void => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (ref.current?.contains(target) === true || anchor.contains(target)) return;
			onClose();
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown);
		};
	}, [anchor, onClose]);
	return (
		<div
			ref={ref}
			className={`settings-menu${compact ? " is-compact" : ""}`}
			role="menu"
			style={position === null ? { left: -9999, top: 0, visibility: "hidden" } : { left: position.left, top: position.top }}
		>
			{children}
		</div>
	);
}

export function ModalShell({ onClose, children }: { readonly onClose: () => void; readonly children: ReactNode }): ReactElement {
	const { t } = useTranslation();
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="settings-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div className="settings-modal" role="dialog" aria-modal="true">
				<button type="button" className="settings-modal-close" aria-label={t("common.close")} onClick={onClose}>
					<X size={14} aria-hidden="true" focusable="false" />
				</button>
				{children}
			</div>
		</div>
	);
}

export function ModalActions({ children }: { readonly children: ReactNode }): ReactElement {
	return <div className="settings-modal-actions">{children}</div>;
}

/** One-field prompt used for path/chip/alias additions. */
export function PromptModal({
	title,
	description,
	label,
	placeholder = "",
	initialValue = "",
	confirmLabel,
	onCancel,
	onSubmit,
}: {
	readonly title: string;
	readonly description: string;
	readonly label: string;
	readonly placeholder?: string;
	readonly initialValue?: string;
	readonly confirmLabel: string;
	readonly onCancel: () => void;
	readonly onSubmit: (value: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const [value, setValue] = useState(initialValue);
	const submit = (): void => {
		const trimmed = value.trim();
		if (trimmed.length > 0) onSubmit(trimmed);
	};
	return (
		<ModalShell onClose={onCancel}>
			<h2>{title}</h2>
			<p>{description}</p>
			<label>
				{label}
				<input
					autoFocus
					value={value}
					placeholder={placeholder}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") submit();
					}}
				/>
			</label>
			<ModalActions>
				<button type="button" className="linear-btn" onClick={onCancel}>
					{t("common.cancel")}
				</button>
				<button type="button" className="linear-btn settings-btn-primary" disabled={value.trim().length === 0} onClick={submit}>
					{confirmLabel}
				</button>
			</ModalActions>
		</ModalShell>
	);
}
