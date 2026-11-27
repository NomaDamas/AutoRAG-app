/**
 * 알림 센터 (Figma 566:14075, opened from the sidebar footer as in 553:6673): the bell, and the panel above it with
 * the problems that still need the person (해결 필요) and the errors the app showed earlier (지난 알림).
 */

import { Bell, Clock, Info, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { DataSourceRow, RefreshScheduleStatus } from "../../../shared/settings-contract";
import type { DefaultFileManagerStatus } from "../../../shared/default-file-manager-contract";
import { evaluateRefreshScheduleHealth, type RefreshScheduleHealthIssue } from "../../../shared/refresh-schedule-health";
import type { SettingsCategory } from "./SettingsView";
import type { SettingsNavigationOptions } from "../state/settings-navigation";
import { startErrorFix } from "../hooks/useErrorFix";
import { retryIndexProblem, useIndexProblem } from "../hooks/useIndexProblem";
import { cn } from "../lib/cn";
import {
	DEFAULT_FILE_MANAGER_NOTICE_ID,
	DEFAULT_FILE_MANAGER_NOTICE_SIGNATURE,
	shouldPromptDefaultFileManager,
} from "../state/default-file-manager-notice";
import { describeIndexProblem } from "../state/index-problem";
import {
	clearPastNotices,
	dismissNotice,
	hasUnseenNotice,
	hideActiveNotice,
	isActiveHidden,
	noticeAge,
	noticeRetry,
	setNotificationCenterOpen,
	useNotifications,
	type NoticeTone,
} from "../state/notifications";
import { NoticeBadge } from "./primitives/NoticeCard";
import { iconButtonClass } from "./primitives/icon-button";
import { sourceTitle } from "./settings/datasourceTemplates";

interface ItemAction {
	readonly label: string;
	readonly kind: "text" | "primary" | "secondary";
	readonly run: () => void;
}

interface ActiveItem {
	readonly id: string;
	readonly signature: string;
	readonly tone: NoticeTone;
	readonly title: string;
	readonly body: string | null;
	readonly at: number | null;
	readonly actions: readonly ItemAction[];
}

/** Figma Button, size 28: 숨기기 is text only, the main action the accent fill, the other one outlined. */
/** The panel stops growing here (about five notices) and scrolls its list; a short window caps it sooner. */
const NOTICE_PANEL_MAX_HEIGHT = 520;

function actionClass(kind: ItemAction["kind"]): string {
	return cn(
		"inline-flex h-28 flex-none items-center justify-center px-10 rounded-6 border text-meta font-medium leading-[16px] whitespace-nowrap cursor-pointer transition-opacity duration-(--dur-color) ease-out hover:opacity-80",
		kind === "primary" ? "border-transparent bg-accent text-on-accent" : kind === "secondary" ? "border-border bg-window text-ink-body" : "border-transparent bg-transparent text-ink-body",
	);
}

function NoticeRow({
	tone,
	title,
	body,
	age,
	actions,
	onDismiss,
}: {
	readonly tone: NoticeTone;
	readonly title: string;
	readonly body: string | null;
	readonly age: string | null;
	readonly actions: readonly ItemAction[];
	readonly onDismiss?: () => void;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<li className="notice-item flex gap-10 border-t border-divider p-12" data-tone={tone}>
			<span className="flex h-[19px] w-16 flex-none items-center justify-center">
				<NoticeBadge tone={tone} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-4">
				<div className="flex items-start gap-6">
					<strong className="min-w-0 flex-1 text-[13px] font-medium leading-[19px] text-ink break-keep [overflow-wrap:anywhere]">{title}</strong>
					{age === null ? null : <span className="flex-none text-[11px] leading-[19px] text-ink-faint">{age}</span>}
					{onDismiss === undefined ? null : (
						<button
							type="button"
							className={cn(iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }), "-ml-5 h-[19px] w-20 flex-none rounded-5")}
							aria-label={t("notifications.dismiss")}
							title={t("notifications.dismiss")}
							onClick={onDismiss}
						>
							<X size={14} strokeWidth={1.28} />
						</button>
					)}
				</div>
				{body === null || body === "" ? null : <p className="m-0 select-text whitespace-pre-wrap [overflow-wrap:anywhere] text-meta leading-[1.5] text-ink-muted">{body}</p>}
				{actions.length === 0 ? null : (
					<div className="flex flex-wrap items-center justify-end gap-8 pt-4">
						{actions.map((action) => (
							<button key={action.label} type="button" className={actionClass(action.kind)} onClick={action.run}>
								{action.label}
							</button>
						))}
					</div>
				)}
			</div>
		</li>
	);
}

function SectionHead({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }): ReactElement {
	return (
		<div className="flex h-36 items-center gap-6 pl-14 pr-12 text-meta font-medium leading-[16px] text-ink-faint">
			{icon}
			<span>{children}</span>
		</div>
	);
}

/** The first line a datasource gives about what is wrong with it. */
function sourceDetail(row: DataSourceRow): string | null {
	for (const detail of [row.install.detail, row.agent.detail, row.index.detail]) {
		if (detail.trim() !== "") return detail.trim();
	}
	return null;
}

// The bell is cut away 2px around the unread dot, so whatever is behind the
// button (the sidebar, its hover, the open state) shows as the dot's outline.
// The dot's centre is 13px right and 2px down from the 16px icon's corner.
const BELL_DOT_CUTOUT = {
	maskImage: "radial-gradient(circle at 13px 2px, transparent 5px, #000 5.5px)",
} as const;

export function NotificationCenter({
	onOpenAiSettings,
	onOpenSettingsPage,
	onboardingPending = false,
}: {
	/** The index problem that wants another embedding opens Settings → AI. */
	readonly onOpenAiSettings?: (() => void) | undefined;
	/** Opens one Settings page by its category (`general`, `indexing`, `source:<alias>`, …), optionally pre-filling its AI assistant. */
	readonly onOpenSettingsPage?: ((category: SettingsCategory, options?: SettingsNavigationOptions) => void) | undefined;
	/** True while first-run onboarding has not finished yet. */
	readonly onboardingPending?: boolean | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const notifications = useNotifications();
	const problem = useIndexProblem();
	const [sources, setSources] = useState<readonly DataSourceRow[]>([]);
	const [allSources, setAllSources] = useState<readonly DataSourceRow[]>([]);
	const [schedule, setSchedule] = useState<RefreshScheduleStatus | null>(null);
	const [signedIn, setSignedIn] = useState(false);
	const [dfmStatus, setDfmStatus] = useState<DefaultFileManagerStatus | null>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const [anchor, setAnchor] = useState<{ readonly left: number; readonly bottom: number } | null>(null);
	const open = notifications.open;
	const close = (): void => setNotificationCenterOpen(false);

	// Track account sign-in state and default-file-manager registration so the prompt appears once onboarding + login finish.
	useEffect(() => {
		let live = true;
		const account = window.autorag?.account;
		if (account !== undefined) {
			void account
				.status()
				.then((snapshot) => {
					if (live) setSignedIn(snapshot.state === "signedIn");
				})
				.catch(() => undefined);
			const offAccount = account.onChanged((snapshot) => {
				if (live) setSignedIn(snapshot.state === "signedIn");
			});
			const dfm = window.autorag?.defaultFileManager;
			let offDfm: (() => void) | undefined;
			if (dfm !== undefined) {
				void dfm
					.status()
					.then((next) => {
						if (live) setDfmStatus(next);
					})
					.catch(() => undefined);
				offDfm = dfm.onChange((next) => {
					if (live) setDfmStatus(next);
				});
			}
			return () => {
				live = false;
				offAccount();
				offDfm?.();
			};
		}
		return () => {
			live = false;
		};
	}, []);

	useEffect(() => {
		if (!open) return;
		let live = true;
		void window.autorag?.defaultFileManager
			?.status()
			.then((next) => {
				if (live) setDfmStatus(next);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [open]);

	// Connections that need attention + schedule health: read on start and every time the panel opens.
	useEffect(() => {
		let live = true;
		const settings = window.autorag?.settings;
		if (settings === undefined) return;
		settings
			.sourcesList?.()
			.then((snapshot) => {
				if (!live) return;
				setAllSources(snapshot.sources);
				setSources(snapshot.sources.filter((row) => row.enabled && row.status === "attention"));
			})
			.catch(() => undefined);
		settings
			.refreshScheduleGet?.()
			.then((status) => {
				if (live && status !== null && status !== undefined) setSchedule(status);
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [open]);

	// Subscribe to periodic background schedule health pushes from the main process.
	useEffect(() => {
		const settings = window.autorag?.settings;
		if (settings?.onRefreshScheduleChanged === undefined) return;
		return settings.onRefreshScheduleChanged((status) => setSchedule(status));
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		const place = (): void => {
			const rect = buttonRef.current?.getBoundingClientRect();
			if (rect !== undefined) setAnchor({ left: Math.max(8, rect.left - 8), bottom: window.innerHeight - rect.top + 6 });
		};
		place();
		window.addEventListener("resize", place);
		return () => window.removeEventListener("resize", place);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				close();
				buttonRef.current?.focus();
			}
		};
		const onDown = (event: MouseEvent): void => {
			const target = event.target as Node;
			if (panelRef.current?.contains(target) === true || buttonRef.current?.contains(target) === true) return;
			close();
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown);
		};
	}, [open]);

	const active: ActiveItem[] = [];
	const view = describeIndexProblem(problem, t);
	if (view !== null && !view.retrying && problem.at !== null) {
		const primary = view.primary;
		const actions: ItemAction[] = [{ label: t("notifications.hide"), kind: "text", run: () => hideActiveNotice("index", problem.at ?? "") }];
		if (problem.failure !== null) actions.push({ label: t("appError.fixAction"), kind: "primary", run: () => { startErrorFix(view.title); close(); } });
		if (primary !== null) {
			actions.push({
				label: primary.label,
				kind: problem.failure === null ? "primary" : "secondary",
				run: () => {
					if (primary.kind === "fixEmbedding") {
						onOpenAiSettings?.();
						close();
					} else retryIndexProblem();
				},
			});
		}
		active.push({ id: "index", signature: problem.at, tone: view.cardTone === "error" ? "error" : "warning", title: view.title, body: view.sideDetail, at: Date.parse(problem.at), actions });
	}
	const sourceLabelById = new Map(allSources.map((row) => [row.id, sourceTitle(row)]));
	const scheduleIssueItem = (issue: RefreshScheduleHealthIssue): ActiveItem => {
		const id = `refresh-schedule:${issue.kind}`;
		const hide: ItemAction = { label: t("notifications.hide"), kind: "text", run: () => hideActiveNotice(id, issue.signature) };
		const fixWithAi = (assistantPrompt: string): ItemAction => ({
			label: t("appError.fixAction"),
			kind: "primary",
			run: () => {
				onOpenSettingsPage?.("indexing", { assistantPrompt });
				close();
			},
		});
		if (issue.kind === "not-registered") {
			return {
				id,
				signature: issue.signature,
				tone: issue.tone,
				title: t("notifications.scheduleNotRegisteredTitle"),
				body: t("notifications.scheduleNotRegisteredBody"),
				at: issue.at,
				actions: [hide, fixWithAi(t("notifications.scheduleNotRegisteredPrompt"))],
			};
		}
		if (issue.kind === "overdue") {
			return {
				id,
				signature: issue.signature,
				tone: issue.tone,
				title: t("notifications.scheduleOverdueTitle"),
				body: t("notifications.scheduleOverdueBody"),
				at: issue.at,
				actions: [hide, fixWithAi(t("notifications.scheduleOverduePrompt"))],
			};
		}
		if (issue.kind === "failing") {
			const items = (issue.failing ?? [])
				.map((item) => (item.kind === "local" ? t("settingsSources.indexing.localFolder") : (sourceLabelById.get(item.id) ?? item.id)))
				.join(", ");
			return {
				id,
				signature: issue.signature,
				tone: issue.tone,
				title: t("notifications.scheduleFailingTitle"),
				body: t("notifications.scheduleFailingBody", { items }),
				at: issue.at,
				actions: [hide, fixWithAi(t("notifications.scheduleFailingPrompt", { items }))],
			};
		}
		const list = (issue.conflicts ?? []).join(", ");
		return {
			id,
			signature: issue.signature,
			tone: issue.tone,
			title: t("notifications.scheduleConflictsTitle"),
			body: t("notifications.scheduleConflictsBody"),
			at: issue.at,
			actions: [hide, fixWithAi(t("notifications.scheduleConflictsPrompt", { list }))],
		};
	};
	const now = Date.now();
	for (const issue of evaluateRefreshScheduleHealth(schedule, now)) {
		active.push(scheduleIssueItem(issue));
	}
	for (const row of sources) {
		const body = sourceDetail(row);
		active.push({
			id: `source:${row.id}`,
			signature: body ?? "",
			tone: "error",
			title: t("notifications.sourceTitle", { name: sourceTitle(row) }),
			body,
			at: null,
			actions: [
				{ label: t("notifications.hide"), kind: "text", run: () => hideActiveNotice(`source:${row.id}`, body ?? "") },
				{ label: t("notifications.openConnection"), kind: "primary", run: () => { onOpenSettingsPage?.(`source:${row.id}`); close(); } },
			],
		});
	}
	if (shouldPromptDefaultFileManager({ onboardingPending, signedIn, status: dfmStatus }) && dfmStatus !== null) {
		const body = dfmStatus.platform === "win32" ? t("notifications.defaultFileManagerBodyWin") : t("notifications.defaultFileManagerBodyMac");
		active.push({
			id: DEFAULT_FILE_MANAGER_NOTICE_ID,
			signature: DEFAULT_FILE_MANAGER_NOTICE_SIGNATURE,
			tone: "warning",
			title: t("notifications.defaultFileManagerTitle"),
			body,
			at: null,
			actions: [
				{
					label: t("notifications.hide"),
					kind: "text",
					run: () => hideActiveNotice(DEFAULT_FILE_MANAGER_NOTICE_ID, DEFAULT_FILE_MANAGER_NOTICE_SIGNATURE),
				},
				{
					label: t("notifications.defaultFileManagerOpenSettings"),
					kind: "secondary",
					run: () => {
						onOpenSettingsPage?.("general");
						close();
					},
				},
				{
					label: t("notifications.defaultFileManagerEnable"),
					kind: "primary",
					run: () => {
						void window.autorag?.defaultFileManager
							?.apply({ enabled: true, interceptReveal: dfmStatus.platform === "win32" })
							.then((next) => setDfmStatus(next))
							.catch(() => undefined);
					},
				},
			],
		});
	}
	const shown = active.filter((item) => !isActiveHidden(notifications.hidden, item.id, item.signature));
	const dot = shown.length > 0 || hasUnseenNotice(notifications);

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				className={cn(iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }), "relative", open && "bg-selected-nav text-ink")}
				data-action="open-notifications"
				aria-label={dot ? t("notifications.openUnread") : t("notifications.open")}
				title={t("notifications.title")}
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => setNotificationCenterOpen(!open)}
			>
				<Bell size={16} strokeWidth={1.6} aria-hidden="true" style={dot ? BELL_DOT_CUTOUT : undefined} />
				{dot ? <span className="absolute top-[5px] right-[6px] size-6 rounded-full bg-danger-dot" aria-hidden="true" /> : null}
			</button>
			{open && anchor !== null
				? createPortal(
						<div
							ref={panelRef}
							className="notification-center fixed z-60 flex w-[332px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-14 border border-border bg-window shadow-[0_12px_32px_rgba(0,0,0,0.16)] animate-[rise_var(--dur-menu)_var(--ease-out)]"
							style={{ left: anchor.left, bottom: anchor.bottom, maxHeight: `min(${NOTICE_PANEL_MAX_HEIGHT}px, calc(100vh - ${anchor.bottom + 16}px))` }}
							role="dialog"
							aria-label={t("notifications.title")}
						>
							<div className="flex flex-none items-center gap-8 px-16 pt-14 pb-10">
								<h2 className="m-0 text-[15px] font-bold text-ink">{t("notifications.title")}</h2>
								<span className="flex-1" />
								{notifications.past.length === 0 ? null : (
									<button type="button" className="border-0 bg-transparent p-0 text-meta leading-[16px] text-accent-text cursor-pointer hover:underline" onClick={clearPastNotices}>
										{t("notifications.clearPast")}
									</button>
								)}
							</div>
							<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
								{shown.length === 0 && notifications.past.length === 0 ? (
									<p className="m-0 border-t border-divider px-16 py-24 text-center text-meta text-ink-muted">{t("notifications.empty")}</p>
								) : null}
								{shown.length === 0 ? null : (
									<section aria-label={t("notifications.needsAction")}>
										<SectionHead icon={<Info size={10} strokeWidth={2} aria-hidden="true" />}>{t("notifications.needsAction")}</SectionHead>
										<ul className="m-0 list-none p-0">
											{shown.map((item) => (
												<NoticeRow key={item.id} tone={item.tone} title={item.title} body={item.body} age={item.at === null || Number.isNaN(item.at) ? null : noticeAge(item.at, now)} actions={item.actions} />
											))}
										</ul>
									</section>
								)}
								{notifications.past.length === 0 ? null : (
									<section aria-label={t("notifications.past")} className={cn(shown.length > 0 && "mt-4 border-t border-divider")}>
										<SectionHead icon={<Clock size={12} strokeWidth={1.8} aria-hidden="true" />}>{t("notifications.past")}</SectionHead>
										<ul className="m-0 list-none p-0">
											{notifications.past.map((entry) => {
												const retry = noticeRetry(entry.id);
												return (
													<NoticeRow
														key={entry.id}
														tone={entry.tone}
														title={entry.title}
														body={entry.body}
														age={noticeAge(entry.at, now)}
														actions={retry === undefined ? [] : [{ label: retry.label, kind: "primary", run: () => { dismissNotice(entry.id); retry.run(); } }]}
														onDismiss={() => dismissNotice(entry.id)}
													/>
												);
											})}
										</ul>
									</section>
								)}
							</div>
							<div className="flex flex-none items-center border-t border-divider px-16 py-12 text-meta leading-[16px] text-ink-body">
								<span className="flex-1" />
								<button type="button" className="border-0 bg-transparent p-0 text-inherit cursor-pointer hover:underline" onClick={() => { onOpenSettingsPage?.("general"); close(); }}>
									{t("notifications.settings")}
								</button>
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
