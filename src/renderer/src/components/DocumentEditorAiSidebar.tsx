import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Highlighter, RotateCcw, X } from "lucide-react";
import { MAX_INSTRUCTION } from "../../../preview/shared/annotation";
import { cn } from "../lib/cn";
import { useDocumentEditorSidebar } from "./DocumentEditorSidebarContext";
import {
	SidebarChatComposer,
	SidebarChatEmpty,
	SidebarChatProgress,
	SidebarChatShell,
	SidebarReplyBody,
} from "./SidebarChat";

/** Dock chip styling matching Finder's InspectorChatDock pills. */
const EDITOR_DOCK_CHIP =
	"inline-flex max-w-full items-center gap-6 rounded-full border border-divider bg-window py-6 pl-9 pr-10 text-meta leading-[16px] text-ink shadow-[0_2px_5px_rgba(20,20,41,0.07)] cursor-pointer transition-colors hover:bg-hover";

/**
 * Right-sidebar AI Editing Chat for the active Document Editor tab.
 * Reuses the exact same right-sidebar chat shell, empty state, user bubbles,
 * borderless prose replies, SeedLoader shimmer progress, and floating composer
 * used in Settings and Finder Inspector chats.
 */
export function DocumentEditorAiSidebar({ filePath }: { readonly filePath: string }): ReactElement {
	const { t } = useTranslation();
	const sidebar = useDocumentEditorSidebar();
	const [draft, setDraft] = useState("");

	const reg = sidebar?.getTab(filePath) ?? null;
	const turns = sidebar?.turnsFor(filePath) ?? [];
	const running = sidebar?.isRunning(filePath) ?? false;

	const isPdf = reg?.surface === "pdf";

	const handleSend = (): void => {
		const trimmed = draft.trim();
		if (trimmed === "" || running || sidebar === null) return;
		setDraft("");
		void sidebar.sendInstruction(filePath, trimmed);
	};

	const placeholder = isPdf
		? t("documentEditor.pdf.aiPlaceholder")
		: reg?.surface === "package"
			? t("documentEditor.package.hint")
			: t("documentEditor.ai.placeholder");

	const latestTurn = turns.at(-1);
	const followKey = `${turns.length}:${latestTurn?.status ?? ""}:${latestTurn?.progress ?? ""}:${latestTurn?.draft.length ?? 0}:${latestTurn?.reply.length ?? 0}`;

	const aboveComposer =
		reg === null ? null : (
			<div className="flex flex-wrap items-center gap-6">
				<button
					type="button"
					aria-pressed={reg.markupActive}
					className={cn(
						EDITOR_DOCK_CHIP,
						reg.markupActive && "border-accent bg-accent-soft text-accent hover:bg-accent-soft",
					)}
					onClick={() => reg.setMarkupActive(!reg.markupActive)}
				>
					<Highlighter size={13} className={reg.markupActive ? "text-accent" : "text-ink-muted"} />
					<span>{t("documentEditor.toolbar.markupToggle")}</span>
				</button>
				{reg.marks.length > 0 ? (
					<span className="inline-flex items-center gap-5 rounded-full bg-accent-soft px-8 py-4 text-badge font-medium text-accent">
						<Highlighter size={11} />
						{t("documentEditor.ai.marksBadge", { count: reg.marks.length })}
						<button
							type="button"
							aria-label={t("quickLook.markup.clear")}
							className="flex size-14 items-center justify-center rounded-full border-0 bg-transparent p-0 text-accent hover:bg-accent/15"
							onClick={() => reg.clearMarks()}
						>
							<X size={10} />
						</button>
					</span>
				) : null}
				{reg.marks.length === 0 && reg.selectedText !== "" ? (
					<span className="inline-flex items-center gap-4 rounded-full bg-accent-soft px-8 py-4 text-badge font-medium text-accent">
						{t("documentEditor.ai.selectionBadge", { chars: reg.selectedText.length })}
					</span>
				) : null}
			</div>
		);

	return (
		<SidebarChatShell
			className="doc-editor-sidebar"
			data-document-editor-sidebar={filePath}
			aria-label={t("documentEditor.ai.title")}
			running={running}
			followKey={followKey}
			footer={
				<SidebarChatComposer
					value={draft}
					onChange={setDraft}
					onSend={handleSend}
					onStop={() => void sidebar?.cancelRun(filePath)}
					onReset={sidebar !== null ? () => sidebar.clearTurns(filePath) : undefined}
					showReset={turns.length > 0 && sidebar !== null}
					running={running}
					disabled={reg === null}
					placeholder={placeholder}
					inputAriaLabel={t("documentEditor.ai.title")}
					sendLabel={t("documentEditor.ai.send")}
					stopLabel={t("common.cancel")}
					resetLabel={t("quickLook.markup.clear")}
					maxLength={MAX_INSTRUCTION}
					above={aboveComposer}
				/>
			}
		>
			{turns.length === 0 ? (
				<SidebarChatEmpty
					title={isPdf ? t("documentEditor.pdf.aiEmptyTitle") : t("documentEditor.ai.emptyTitle")}
					description={isPdf ? t("documentEditor.pdf.aiEmptyDesc") : t("documentEditor.ai.emptyDesc")}
				/>
			) : (
				<div className="customizer-panel__turns">
					{turns.map((turn) => (
						<div key={turn.id} className="customizer-turn">
							{/* User bubble — identical dark 16px pill to Finder & Settings right sidebar */}
							<div className="customizer-turn__user-row">
								<div className="flex max-w-[82%] flex-col items-end gap-4">
									{turn.marksCount > 0 ? (
										<span className="inline-flex items-center gap-4 rounded-full bg-accent-soft px-7 py-2 text-badge font-medium text-accent">
											<Highlighter size={10} />
											{t("documentEditor.ai.marksBadge", { count: turn.marksCount })}
										</span>
									) : turn.selectionChars > 0 ? (
										<span className="inline-flex items-center gap-4 rounded-full bg-accent-soft px-7 py-2 text-badge font-medium text-accent">
											{t("documentEditor.ai.selectionBadge", { chars: turn.selectionChars })}
										</span>
									) : null}
									<div className="customizer-turn__user-bubble max-w-full">{turn.instruction}</div>
								</div>
							</div>

							{/* Assistant reply — borderless prose + change pill + SeedLoader progress */}
							<div
								className="customizer-turn__assistant-row"
								data-edit-state={turn.status === "done" ? (turn.changed ? "changed" : "unchanged") : turn.status}
								role="status"
							>
								{turn.status === "running" ? (
									<>
										{turn.draft !== "" ? <SidebarReplyBody text={turn.draft} /> : null}
										<SidebarChatProgress text={turn.progress !== "" ? turn.progress : t("documentEditor.ai.working")} />
									</>
								) : turn.status === "done" ? (
									<>
										{turn.changed ? (
											<div className="flex w-full flex-wrap items-center justify-between gap-8">
												<span className="customizer-change-pill">
													<Check size={14} strokeWidth={1.8} aria-hidden="true" />
													<span>{t("documentEditor.ai.changed")}</span>
												</span>
												{sidebar !== null ? (
													<button
														type="button"
														className="inline-flex h-22 items-center gap-4 rounded-6 border border-divider bg-window px-8 text-badge font-medium text-ink-body transition-colors hover:bg-hover hover:text-ink"
														onClick={() => void sidebar.undoTurn(filePath, turn.id)}
													>
														<RotateCcw size={11} />
														{t("documentEditor.ai.undo")}
													</button>
												) : null}
											</div>
										) : turn.reply === "" ? (
											<p className="m-0 text-meta text-ink-muted">{t("documentEditor.ai.unchanged")}</p>
										) : null}
										{turn.reply !== "" ? <SidebarReplyBody text={turn.reply} /> : null}
									</>
								) : turn.status === "error" ? (
									<div className="customizer-turn__error w-full" role="alert">
										<p className="customizer-turn__error-text break-words [overflow-wrap:anywhere]">
											{t("documentEditor.ai.failed", { message: turn.error ?? "" })}
										</p>
									</div>
								) : turn.status === "cancelled" ? (
									<p className="m-0 text-meta text-ink-muted">{t("documentEditor.ai.cancelled")}</p>
								) : (
									<p className="m-0 text-meta text-ink-muted">{t("documentEditor.ai.undone")}</p>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</SidebarChatShell>
	);
}
