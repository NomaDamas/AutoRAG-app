import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, FileText, Highlighter, Loader2, PenLine, RotateCcw, Sparkles, Square, Trash2, X } from "lucide-react";
import { MAX_INSTRUCTION } from "../../../preview/shared/annotation";
import { cn } from "../lib/cn";
import { useDocumentEditorSidebar } from "./DocumentEditorSidebarContext";

/**
 * Right-sidebar AI Editing Chat for the active Document Editor tab.
 * Receives live marks (pen/box/underline) and text selections drawn on the
 * document editor stage, runs the `document-edit` agent, streams progress and
 * replies, and lets the user undo any AI edit turn in place.
 */
export function DocumentEditorAiSidebar({ filePath }: { readonly filePath: string }): ReactElement {
	const { t } = useTranslation();
	const sidebar = useDocumentEditorSidebar();
	const [draft, setDraft] = useState("");
	const endRef = useRef<HTMLDivElement | null>(null);

	const reg = sidebar?.getTab(filePath) ?? null;
	const turns = sidebar?.turnsFor(filePath) ?? [];
	const running = sidebar?.isRunning(filePath) ?? false;

	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "end" });
	}, [turns.length, running]);

	const fileName = reg?.fileName ?? filePath.split(/[\\/]/).at(-1) ?? filePath;
	const isPdf = reg?.surface === "pdf";

	const handleSend = (): void => {
		const trimmed = draft.trim();
		if (trimmed === "" || running || sidebar === null || isPdf) return;
		setDraft("");
		void sidebar.sendInstruction(filePath, trimmed);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			handleSend();
		}
	};

	return (
		<aside
			className="doc-editor-sidebar flex min-h-0 flex-1 flex-col bg-window text-ink"
			data-document-editor-sidebar={filePath}
			aria-label={t("documentEditor.ai.title")}
		>
			{/* Sidebar Header */}
			<div className="flex flex-none items-center justify-between gap-8 border-b border-divider px-14 py-10">
				<div className="flex min-w-0 items-center gap-6">
					<Sparkles size={14} className="flex-none text-accent" />
					<div className="min-w-0">
						<div className="truncate text-body font-semibold text-ink">{t("documentEditor.ai.title")}</div>
						<div className="truncate text-badge text-ink-muted" title={filePath}>
							{fileName}
						</div>
					</div>
				</div>
				{turns.length > 0 && sidebar !== null ? (
					<button
						type="button"
						disabled={running}
						title={t("quickLook.markup.clear")}
						aria-label={t("quickLook.markup.clear")}
						className="flex size-24 flex-none items-center justify-center rounded-6 border-0 bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink disabled:opacity-40"
						onClick={() => sidebar.clearTurns(filePath)}
					>
						<Trash2 size={13} />
					</button>
				) : null}
			</div>

			{/* Body */}
			{isPdf ? (
				<div className="flex flex-1 flex-col gap-12 overflow-y-auto px-14 py-16 text-meta text-ink-body">
					<div className="flex items-start gap-8 rounded-12 border border-divider bg-subtle p-12">
						<PenLine size={15} className="mt-1 flex-none text-accent" />
						<div className="flex flex-col gap-4">
							<div className="font-semibold text-ink">{t("documentEditor.pdf.sidebarTitle")}</div>
							<p className="m-0 leading-[1.5] text-ink-muted">{t("documentEditor.pdf.sidebarDesc")}</p>
						</div>
					</div>
					<ul className="m-0 flex list-disc flex-col gap-6 pl-18 text-ink-muted">
						<li>{t("documentEditor.pdf.tipSignature")}</li>
						<li>{t("documentEditor.pdf.tipCrop")}</li>
						<li>{t("documentEditor.pdf.tipPages")}</li>
					</ul>
				</div>
			) : (
				<>
					{/* Chat transcript */}
					<div className="flex min-h-0 flex-1 flex-col gap-10 overflow-y-auto px-14 py-12">
						{turns.length === 0 ? (
							<div className="flex flex-1 flex-col items-center justify-center gap-8 px-8 text-center">
								<div className="flex size-36 items-center justify-center rounded-full bg-accent-soft text-accent">
									<FileText size={18} />
								</div>
								<div className="text-body font-semibold text-ink">{t("documentEditor.ai.emptyTitle")}</div>
								<p className="m-0 text-meta leading-[1.5] text-ink-muted">{t("documentEditor.ai.emptyDesc")}</p>
								{reg !== null && !reg.markupActive ? (
									<button
										type="button"
										className="mt-4 inline-flex h-28 items-center gap-6 rounded-7 border border-border bg-subtle px-12 text-meta font-medium text-ink hover:bg-hover-row"
										onClick={() => reg.setMarkupActive(true)}
									>
										<Highlighter size={13} className="text-accent" />
										{t("documentEditor.toolbar.markupToggle")}
									</button>
								) : null}
							</div>
						) : (
							turns.map((turn) => (
								<div key={turn.id} className="flex flex-col gap-6">
									{/* User turn */}
									<div className="ml-auto max-w-[92%] rounded-10 bg-chip-sent px-10 py-8 text-body text-ink">
										{turn.marksCount > 0 ? (
											<div className="mb-4 inline-flex items-center gap-4 rounded-full bg-accent-soft px-7 py-1 text-badge font-medium text-accent">
												<Highlighter size={10} />
												{t("documentEditor.ai.marksBadge", { count: turn.marksCount })}
											</div>
										) : turn.selectionChars > 0 ? (
											<div className="mb-4 inline-flex items-center gap-4 rounded-full bg-accent-soft px-7 py-1 text-badge font-medium text-accent">
												{t("documentEditor.ai.selectionBadge", { chars: turn.selectionChars })}
											</div>
										) : null}
										<div className="whitespace-pre-wrap break-words">{turn.instruction}</div>
									</div>

									{/* Assistant turn */}
									<div
										className="flex flex-col gap-6 rounded-12 border border-divider bg-subtle px-10 py-8 text-meta"
										data-edit-state={turn.status === "done" ? (turn.changed ? "changed" : "unchanged") : turn.status}
										role="status"
									>
										{turn.status === "running" ? (
											<>
												<div className="flex items-center gap-6 font-medium text-ink">
													<Loader2 size={13} className="flex-none animate-spin text-accent" />
													<span>{t("documentEditor.ai.working")}</span>
												</div>
												{turn.progress !== "" ? <div className="text-ink-muted">{turn.progress}</div> : null}
												{turn.draft !== "" ? (
													<div className="max-h-140 overflow-auto whitespace-pre-wrap text-ink-body">{turn.draft}</div>
												) : null}
											</>
										) : turn.status === "done" ? (
											<>
												<div className="flex items-center justify-between gap-6">
													<span className="font-semibold text-ink">
														{turn.changed ? t("documentEditor.ai.changed") : t("documentEditor.ai.unchanged")}
													</span>
													{turn.changed && sidebar !== null ? (
														<button
															type="button"
															className="inline-flex h-22 items-center gap-4 rounded-5 border border-border bg-window px-8 text-badge font-medium text-ink hover:bg-hover-row"
															onClick={() => void sidebar.undoTurn(filePath, turn.id)}
														>
															<RotateCcw size={11} />
															{t("documentEditor.ai.undo")}
														</button>
													) : null}
												</div>
												{turn.reply !== "" ? (
													<div className="whitespace-pre-wrap break-words leading-[1.5] text-ink-body">{turn.reply}</div>
												) : null}
											</>
										) : turn.status === "error" ? (
											<div className="text-error" role="alert">
												{t("documentEditor.ai.failed", { message: turn.error ?? "" })}
											</div>
										) : turn.status === "cancelled" ? (
											<div className="text-ink-muted">{t("documentEditor.ai.cancelled")}</div>
										) : (
											<div className="text-ink-muted">{t("documentEditor.ai.undone")}</div>
										)}
									</div>
								</div>
							))
						)}
						<div ref={endRef} />
					</div>

					{/* Attached annotations / selection context bar + Composer */}
					<div className="flex flex-none flex-col gap-6 border-t border-divider bg-window p-10">
						{reg !== null && (reg.marks.length > 0 || reg.selectedText !== "") ? (
							<div className="flex flex-wrap items-center gap-4">
								{reg.marks.length > 0 ? (
									<span className="inline-flex items-center gap-5 rounded-full bg-accent-soft px-8 py-2 text-badge font-medium text-accent">
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
									<span className="inline-flex items-center gap-4 rounded-full bg-accent-soft px-8 py-2 text-badge font-medium text-accent">
										{t("documentEditor.ai.selectionBadge", { chars: reg.selectedText.length })}
									</span>
								) : null}
							</div>
						) : null}

						<div className="flex flex-col gap-6 rounded-12 border border-border bg-input p-8 focus-within:border-accent">
							<textarea
								rows={2}
								value={draft}
								maxLength={MAX_INSTRUCTION}
								disabled={running || reg === null}
								aria-label={t("documentEditor.ai.title")}
								placeholder={
									reg?.surface === "package"
										? t("documentEditor.package.hint")
										: t("documentEditor.ai.placeholder")
								}
								className="w-full resize-none border-0 bg-transparent text-body leading-[1.45] text-ink outline-none placeholder:text-ink-faint"
								onChange={(event) => setDraft(event.target.value)}
								onKeyDown={onKeyDown}
							/>
							<div className="flex items-center justify-between gap-6">
								{reg !== null ? (
									<button
										type="button"
										aria-pressed={reg.markupActive}
										className={cn(
											"inline-flex h-24 items-center gap-4 rounded-6 border-0 px-8 text-badge font-medium transition-colors",
											reg.markupActive
												? "bg-accent-soft text-accent"
												: "bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink",
										)}
										onClick={() => reg.setMarkupActive(!reg.markupActive)}
									>
										<Highlighter size={12} />
										{t("documentEditor.toolbar.markupToggle")}
									</button>
								) : (
									<span />
								)}
								{running ? (
									<button
										type="button"
										aria-label={t("common.cancel")}
										className="flex size-26 items-center justify-center rounded-full border-0 bg-ink text-window hover:opacity-85"
										onClick={() => void sidebar?.cancelRun(filePath)}
									>
										<Square size={10} fill="currentColor" />
									</button>
								) : (
									<button
										type="button"
										aria-label={t("documentEditor.ai.send")}
										disabled={draft.trim() === "" || reg === null}
										className="flex size-26 items-center justify-center rounded-full border-0 bg-accent text-on-accent hover:opacity-90 disabled:opacity-35"
										onClick={handleSend}
									>
										<ArrowUp size={14} strokeWidth={2.4} />
									</button>
								)}
							</div>
						</div>
					</div>
				</>
			)}
		</aside>
	);
}
