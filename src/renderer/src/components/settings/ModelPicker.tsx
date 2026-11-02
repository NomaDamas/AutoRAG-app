import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Search } from "lucide-react";
import type { ModelCatalogEntry, ProviderSummary } from "../../../../shared/settings-contract";
import { AppIcon } from "./SettingsKit";

export type RolePickerSelection =
	| { readonly kind: "model"; readonly provider: string; readonly modelId: string }
	| { readonly kind: "special"; readonly value: string }
	| null;

interface ProviderBucket {
	readonly provider: ProviderSummary;
	readonly models: readonly ModelCatalogEntry[];
}

interface SubmenuAnchor {
	readonly providerId: string;
	readonly trigger: HTMLButtonElement;
}

const SUBMENU_WIDTH = 256;
const SUBMENU_GAP = 4;
const VIEWPORT_MARGIN = 12;

function groupByProvider(
	entries: readonly { readonly provider: ProviderSummary; readonly model: ModelCatalogEntry }[],
	filter?: (entry: { readonly provider: ProviderSummary; readonly model: ModelCatalogEntry }) => boolean,
): ProviderBucket[] {
	const map = new Map<string, { readonly provider: ProviderSummary; readonly models: ModelCatalogEntry[] }>();
	for (const entry of entries) {
		if (filter !== undefined && !filter(entry)) continue;
		const existing = map.get(entry.provider.id);
		if (existing !== undefined) {
			existing.models.push(entry.model);
		} else {
			map.set(entry.provider.id, { provider: entry.provider, models: [entry.model] });
		}
	}
	return [...map.values()];
}

function isModelSelected(selected: RolePickerSelection | undefined, model: ModelCatalogEntry): boolean {
	return selected?.kind === "model" && selected.provider === model.provider && selected.modelId === model.id;
}

/**
 * Hierarchical provider → model picker with top search bar.
 *
 * - Default browse mode (empty query): lists connected providers with a submenu
 *   arrow; hovering, clicking, or pressing ArrowRight opens that provider's
 *   models in a side flyout panel, with role specials (`Same as Answer`, `Off`,
 *   etc.) separated at the bottom.
 * - Search mode (non-empty query): replaces the submenu tree with an inline
 *   list grouped by provider (with provider icon headers and dividers).
 */
export function RolePicker({
	role,
	models,
	specials,
	selected = null,
	onPick,
	onSpecial,
}: {
	readonly role: string;
	readonly models: readonly { readonly provider: ProviderSummary; readonly model: ModelCatalogEntry }[];
	readonly specials: readonly { readonly value: string; readonly label: string }[];
	readonly selected?: RolePickerSelection;
	readonly onPick: (entry: ModelCatalogEntry) => void;
	readonly onSpecial: (special: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [submenu, setSubmenu] = useState<SubmenuAnchor | null>(null);
	const submenuRef = useRef<HTMLDivElement>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const lower = query.trim().toLowerCase();
	const isSearching = lower.length > 0;

	const allBuckets = useMemo(() => groupByProvider(models), [models]);
	const filteredBuckets = useMemo(() => {
		if (!isSearching) return allBuckets;
		const match = (text: string): boolean => text.toLowerCase().includes(lower);
		return groupByProvider(models, (entry) => match(entry.model.name) || match(entry.model.id) || match(entry.provider.name));
	}, [allBuckets, isSearching, lower, models]);

	const cancelClose = useCallback((): void => {
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	const scheduleClose = useCallback((): void => {
		cancelClose();
		closeTimerRef.current = setTimeout(() => {
			setSubmenu(null);
			closeTimerRef.current = null;
		}, 120);
	}, [cancelClose]);

	useEffect(() => () => cancelClose(), [cancelClose]);

	useEffect(() => {
		if (isSearching) setSubmenu(null);
	}, [isSearching]);

	const openProvider = useCallback(
		(providerId: string, trigger: HTMLButtonElement, focusFirstModel = false): void => {
			cancelClose();
			setSubmenu({ providerId, trigger });
			if (focusFirstModel) {
				queueMicrotask(() => {
					submenuRef.current?.querySelector<HTMLButtonElement>(".settings-menu-item")?.focus();
				});
			}
		},
		[cancelClose],
	);

	const activeBucket = !isSearching && submenu !== null ? (allBuckets.find((bucket) => bucket.provider.id === submenu.providerId) ?? null) : null;

	const emptyText = isSearching
		? t("settingsCore.ai.emptySearchModels")
		: role === "jev" || role === "rerank"
			? t("settingsCore.ai.emptyRoleModels")
			: t("settingsCore.ai.emptyModels");

	return (
		<div className="settings-model-picker" onMouseLeave={scheduleClose} onMouseEnter={cancelClose}>
			<label className="settings-menu-search">
				<Search size={14} aria-hidden="true" focusable="false" />
				<input
					autoFocus
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("settingsCore.ai.searchModels")}
				/>
			</label>
			<div className="settings-model-picker-list" onScroll={() => setSubmenu((current) => (current === null ? null : { ...current }))}>
				{isSearching ? (
					filteredBuckets.length === 0 ? (
						<p className="settings-menu-empty">{emptyText}</p>
					) : (
						filteredBuckets.map((bucket, index) => (
							<div key={bucket.provider.id} className="settings-model-search-section">
								{index > 0 ? <div className="settings-menu-sep" /> : null}
								<p className="settings-menu-group is-provider">
									<AppIcon small label={bucket.provider.name} />
									<span>{bucket.provider.name}</span>
								</p>
								{bucket.models.map((model) => {
									const checked = isModelSelected(selected, model);
									return (
										<button
											key={`${model.provider}/${model.id}`}
											type="button"
											role="menuitemradio"
											aria-checked={checked}
											className={`settings-menu-item${checked ? " is-selected" : ""}`}
											data-model-id={`${model.provider}/${model.id}`}
											onClick={() => onPick(model)}
										>
											<span>{model.name || model.id}</span>
											<small>{model.id}</small>
											{checked ? <Check size={14} aria-hidden="true" focusable="false" /> : null}
										</button>
									);
								})}
							</div>
						))
					)
				) : (
					<>
						{allBuckets.length === 0 ? (
							<p className="settings-menu-empty">{emptyText}</p>
						) : (
							allBuckets.map((bucket) => {
								const isOpen = activeBucket?.provider.id === bucket.provider.id;
								const hasSelectedModel = selected?.kind === "model" && selected.provider === bucket.provider.id;
								return (
									<button
										key={bucket.provider.id}
										type="button"
										role="menuitem"
										aria-haspopup="menu"
										aria-expanded={isOpen}
										className={`settings-menu-item settings-provider-trigger${isOpen ? " is-open" : ""}`}
										data-provider-trigger={bucket.provider.id}
										onMouseEnter={(event) => openProvider(bucket.provider.id, event.currentTarget)}
										onClick={(event) => {
											if (isOpen) setSubmenu(null);
											else openProvider(bucket.provider.id, event.currentTarget);
										}}
										onKeyDown={(event) => {
											if (event.key === "ArrowRight") {
												event.preventDefault();
												openProvider(bucket.provider.id, event.currentTarget, true);
											} else if (event.key === "ArrowLeft" && isOpen) {
												event.preventDefault();
												setSubmenu(null);
											}
										}}
									>
										<AppIcon small label={bucket.provider.name} />
										<span>{bucket.provider.name}</span>
										{hasSelectedModel ? <span className="settings-provider-active-dot" aria-hidden="true" /> : null}
										<ChevronRight size={14} className="settings-menu-chevron" aria-hidden="true" focusable="false" />
									</button>
								);
							})
						)}
						{specials.length > 0 ? (
							<>
								<div className="settings-menu-sep" />
								{specials.map((special) => {
									const checked = selected?.kind === "special" && selected.value === special.value;
									return (
										<button
											key={special.value}
											type="button"
											role="menuitemradio"
											aria-checked={checked}
											className={`settings-menu-item${checked ? " is-selected" : ""}`}
											data-special-value={special.value}
											onMouseEnter={() => {
												cancelClose();
												setSubmenu(null);
											}}
											onClick={() => onSpecial(special.value)}
										>
											<span>{special.label}</span>
											{checked ? <Check size={14} aria-hidden="true" focusable="false" /> : null}
										</button>
									);
								})}
							</>
						) : null}
					</>
				)}
			</div>
			{activeBucket !== null && submenu !== null ? (
				<ProviderSubmenu
					refObj={submenuRef}
					bucket={activeBucket}
					trigger={submenu.trigger}
					selected={selected}
					onPick={onPick}
					onCloseSubmenu={() => {
						const trigger = submenu.trigger;
						setSubmenu(null);
						trigger.focus();
					}}
				/>
			) : null}
		</div>
	);
}

function ProviderSubmenu({
	refObj,
	bucket,
	trigger,
	selected,
	onPick,
	onCloseSubmenu,
}: {
	readonly refObj: React.RefObject<HTMLDivElement | null>;
	readonly bucket: ProviderBucket;
	readonly trigger: HTMLButtonElement;
	readonly selected: RolePickerSelection | undefined;
	readonly onPick: (entry: ModelCatalogEntry) => void;
	readonly onCloseSubmenu: () => void;
}): ReactElement {
	const [position, setPosition] = useState<{ left: number; top: number; side: "left" | "right" } | null>(null);

	const place = useCallback((): void => {
		const panel = refObj.current;
		if (panel === null || !trigger.isConnected) return;
		const parentMenu = trigger.closest(".settings-menu");
		const menuRect = (parentMenu ?? trigger).getBoundingClientRect();
		const rowRect = trigger.getBoundingClientRect();
		const width = panel.offsetWidth || SUBMENU_WIDTH;
		const height = panel.offsetHeight;

		// Prefer opening to the left (matching the reference layout for right-aligned triggers),
		// flipping to the right when the left viewport margin cannot fit the panel.
		const leftCandidate = menuRect.left - SUBMENU_GAP - width;
		const rightCandidate = menuRect.right + SUBMENU_GAP;
		const side: "left" | "right" =
			leftCandidate >= VIEWPORT_MARGIN || rightCandidate + width > window.innerWidth - VIEWPORT_MARGIN
				? "left"
				: "right";
		const rawLeft = side === "left" ? leftCandidate : rightCandidate;
		const left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, window.innerWidth - width - VIEWPORT_MARGIN));
		const preferredTop = rowRect.top - 5;
		const top = Math.max(VIEWPORT_MARGIN, Math.min(preferredTop, window.innerHeight - height - VIEWPORT_MARGIN));
		setPosition({ left, top, side });
	}, [refObj, trigger]);

	useLayoutEffect(() => {
		place();
	}, [place, bucket.provider.id, bucket.models.length]);

	useEffect(() => {
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [place]);

	return (
		<div
			ref={refObj}
			role="menu"
			aria-label={bucket.provider.name}
			data-provider-submenu={bucket.provider.id}
			data-side={position?.side ?? "left"}
			className="settings-menu settings-submenu"
			style={position === null ? { left: -9999, top: 0, visibility: "hidden" } : { left: position.left, top: position.top }}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") {
					event.preventDefault();
					event.stopPropagation();
					onCloseSubmenu();
				}
			}}
		>
			<div className="settings-submenu-list">
				{bucket.models.map((model) => {
					const checked = isModelSelected(selected, model);
					return (
						<button
							key={`${model.provider}/${model.id}`}
							type="button"
							role="menuitemradio"
							aria-checked={checked}
							className={`settings-menu-item${checked ? " is-selected" : ""}`}
							data-model-id={`${model.provider}/${model.id}`}
							onClick={() => onPick(model)}
						>
							<span>{model.name || model.id}</span>
							<small>{model.id}</small>
							{checked ? <Check size={14} aria-hidden="true" focusable="false" /> : null}
						</button>
					);
				})}
			</div>
		</div>
	);
}
