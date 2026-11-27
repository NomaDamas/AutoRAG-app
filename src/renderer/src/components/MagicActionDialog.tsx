import { Check, Copy, Minus, Sparkles, Terminal, X } from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dismissMagicActionDialog, stopMagicActionRun, useMagicActionSession } from "../hooks/useMagicAction";
import { cn } from "../lib/cn";
import { parseAnswerBlocks, parseInline, type InlineSegment } from "../state/answer-markdown";
import { basename } from "../state/paths";
import { noticeButtonClass } from "./primitives/NoticeCard";

/** Figma Button, size 32 (568:7806–7808): the same buttons the notice cards use. */
function Button({
	primary = false,
	onClick,
	children,
	dataAction,
	disabled = false,
}: {
	readonly primary?: boolean;
	readonly onClick: () => void;
	readonly children: ReactNode;
	readonly dataAction?: string;
	readonly disabled?: boolean;
}): ReactElement {
	return (
		<button
			type="button"
			data-action={dataAction}
			className={cn(noticeButtonClass(primary), "disabled:cursor-default disabled:opacity-50 disabled:hover:opacity-50")}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

type SaveState = "idle" | "saving" | "saved" | "failed";

function renderInlineSegments(segments: readonly InlineSegment[]): ReactElement[] {
	return segments.map((seg, idx) => {
		switch (seg.kind) {
			case "bold":
				return <strong key={idx}>{seg.text}</strong>;
			case "code":
				return <code key={idx} className="rounded-4 bg-code px-4 py-1 font-mono text-badge">{seg.text}</code>;
			case "link":
				return <span key={idx}>{renderInlineSegments(seg.children)}</span>;
			case "citation":
				return <span key={idx}>[{seg.number}]</span>;
			case "file":
				return <span key={idx}>{basename(seg.path)}</span>;
			case "image":
				return <span key={idx}>{seg.target}</span>;
			default:
				return <span key={idx}>{seg.text}</span>;
		}
	});
}

function MarkdownBody({ text }: { readonly text: string }): ReactElement {
	const blocks = parseAnswerBlocks(text);
	return (
		<div className="flex flex-col gap-4 text-left text-meta leading-[1.6] text-ink-body" data-testid="magic-action-output">
			{blocks.map((block, idx) => {
				if (block.kind === "code") {
					return (
						<pre key={idx} className="m-0 overflow-x-auto rounded-6 bg-code p-10 font-mono text-badge text-ink">
							<code>{block.text}</code>
						</pre>
					);
				}
				if (block.kind === "table") {
					return (
						<div key={idx} className="overflow-x-auto rounded-6 border border-border">
							<table className="w-full border-collapse text-badge">
								{block.header !== undefined && block.header !== null ? (
									<thead>
										<tr className="border-b border-border bg-chrome">
											{block.header.map((cell, cIdx) => (
												<th key={cIdx} className="px-8 py-6 text-left font-semibold text-ink">
													{renderInlineSegments(parseInline(cell))}
												</th>
											))}
										</tr>
									</thead>
								) : null}
								<tbody>
									{block.rows.map((row, rIdx) => (
										<tr key={rIdx} className="border-b border-divider last:border-b-0">
											{row.map((cell, cIdx) => (
												<td key={cIdx} className="px-8 py-6 text-ink-body">
													{renderInlineSegments(parseInline(cell))}
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					);
				}
				if (block.kind === "list") {
					return (
						<div key={idx} className="flex items-start gap-6">
							<span className="text-ink-muted" aria-hidden="true">•</span>
							<span className="flex-1">{renderInlineSegments(parseInline(block.text))}</span>
						</div>
					);
				}
				if (block.kind === "heading") {
					return (
						<p key={idx} className="m-0 mb-4 font-bold text-ink [&:not(:first-child)]:mt-4">
							{renderInlineSegments(parseInline(block.text))}
						</p>
					);
				}
				return (
					<p key={idx} className="m-0 whitespace-pre-wrap">
						{renderInlineSegments(parseInline(block.text))}
					</p>
				);
			})}
		</div>
	);
}

export function MagicActionDialog(): ReactElement | null {
	const { t } = useTranslation();
	const session = useMagicActionSession();
	const { dialogOpen, run } = session;
	const [copied, setCopied] = useState(false);
	const [saveState, setSaveState] = useState<SaveState>("idle");

	useEffect(() => {
		setCopied(false);
		setSaveState("idle");
	}, [run]);

	useEffect(() => {
		if (!dialogOpen) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") dismissMagicActionDialog();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [dialogOpen]);

	if (!dialogOpen || run.status === "idle") return null;

	const title =
		run.status === "done" ? run.result.actionLabel : run.actionLabel;
	const paths =
		run.status === "done" ? run.result.paths : run.paths;
	const isScript =
		run.status === "done"
			? run.result.executionKind === "script"
			: run.status === "running" && run.executionKind === "script";
	const isRunning = run.status === "running";

	const copyOutput = (text: string): void => {
		void navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1800);
		});
	};

	/** 채팅 기록에 저장: the run becomes a chat in AI 에이전트's history; the button then reads 저장됨. */
	const saveToHistory = (output: string): void => {
		const bridge = window.autorag?.magicAction;
		if (run.status !== "done" || bridge?.saveToHistory === undefined || saveState === "saving" || saveState === "saved") return;
		setSaveState("saving");
		bridge
			.saveToHistory({ actionLabel: run.result.actionLabel, paths: run.result.paths, output })
			.then(() => setSaveState("saved"))
			.catch(() => setSaveState("failed"));
	};

	let body: ReactElement | null = null;
	let footerActions: ReactNode = null;

	if (run.status === "running") {
		const statusText = run.progress ?? t("magicAction.running");
		body = (
			<div className="flex flex-col gap-10">
				<div className="flex items-center gap-8 text-meta text-ink-muted" role="status" data-testid="magic-action-progress">
					<span className="shimmer font-medium">{statusText}</span>
				</div>
				{run.draft.trim().length > 0 ? (
					<div className="max-h-[46vh] overflow-y-auto rounded-8 bg-code p-12">
						{run.executionKind === "script" ? (
							<pre className="m-0 whitespace-pre-wrap break-words font-mono text-badge text-ink">{run.draft}</pre>
						) : (
							<MarkdownBody text={run.draft} />
						)}
					</div>
				) : null}
			</div>
		);
		footerActions = (
			<>
				<Button primary dataAction="minimize-magic-action" onClick={dismissMagicActionDialog}>
					{t("magicAction.minimize")}
				</Button>
				<Button dataAction="stop-magic-action" onClick={stopMagicActionRun}>
					{t("magicAction.stop")}
				</Button>
			</>
		);
	} else if (run.status === "done") {
		const output = run.result.output.trim();
		const canSave = output.length > 0 && window.autorag?.magicAction?.saveToHistory !== undefined;
		body = (
			<div className="max-h-[52vh] overflow-y-auto rounded-8 bg-code p-12">
				{output.length === 0 ? (
					<p className="m-0 text-meta text-ink-muted" data-testid="magic-action-output">
						{t("magicAction.emptyOutput")}
					</p>
				) : run.result.executionKind === "script" ? (
					<pre
						className="m-0 whitespace-pre-wrap break-words font-mono text-badge text-ink"
						data-testid="magic-action-output"
					>
						{output}
					</pre>
				) : (
					<MarkdownBody text={output} />
				)}
			</div>
		);
		footerActions = (
			<>
				{saveState === "failed" ? (
					<span className="mr-auto text-meta text-danger-text" role="status">
						{t("magicAction.saveFailed")}
					</span>
				) : null}
				{canSave ? (
					<Button primary dataAction="save-magic-action-to-history" disabled={saveState === "saving" || saveState === "saved"} onClick={() => saveToHistory(output)}>
						{saveState === "saved" ? <Check size={14} aria-hidden="true" /> : null}
						<span>{saveState === "saved" ? t("magicAction.savedToHistory") : t("magicAction.saveToHistory")}</span>
					</Button>
				) : null}
				{output.length > 0 ? (
					<Button dataAction="copy-magic-action-output" onClick={() => copyOutput(output)}>
						{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
						<span>{copied ? t("magicAction.copied") : t("magicAction.copyOutput")}</span>
					</Button>
				) : null}
				<Button dataAction="close-magic-action" onClick={dismissMagicActionDialog}>
					{t("magicAction.close")}
				</Button>
			</>
		);
	} else if (run.status === "failed") {
		body = (
			<p
				className="m-0 max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded-8 bg-danger-bg-soft p-12 text-meta leading-[16px] text-(--danger-text-strong)"
				role="alert"
				aria-label={t("magicAction.failedTitle")}
				data-testid="magic-action-error"
			>
				{run.message}
			</p>
		);
		footerActions = (
			<Button dataAction="close-magic-action" onClick={dismissMagicActionDialog}>
				{t("magicAction.close")}
			</Button>
		);
	} else if (run.status === "stopped") {
		body = (
			<p className="m-0 text-meta text-ink-muted">{t("magicAction.stoppedTitle")}</p>
		);
		footerActions = (
			<Button dataAction="close-magic-action" onClick={dismissMagicActionDialog}>
				{t("magicAction.close")}
			</Button>
		);
	}

	const targetSummary =
		paths.length === 1 ? basename(paths[0] ?? "") : t("magicAction.targetsCount", { count: paths.length });

	return (
		<div
			className="fixed inset-0 z-80 flex items-center justify-center bg-black/30"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) dismissMagicActionDialog();
			}}
		>
			<div
				className="flex max-h-[84vh] w-[520px] max-w-[92vw] flex-col gap-14 overflow-hidden rounded-modal-lg border border-border bg-window p-18 shadow-[var(--shadow-notice)] animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				data-testid="magic-action-dialog"
			>
				{/* Figma 568:7806–7808: the action's mark, its name over the file it ran on, minimise (running) or close. */}
				<div className="flex items-center gap-8">
					<span className="flex size-24 flex-none items-center justify-center text-accent" aria-hidden="true">
						{isScript ? <Terminal size={14} strokeWidth={1.8} /> : <Sparkles size={14} strokeWidth={1.8} />}
					</span>
					<div className="flex min-w-0 flex-1 flex-col">
						<strong className="truncate text-[13px] font-bold text-ink">{title}</strong>
						<span className="truncate text-meta text-ink-muted" title={paths.join("\n")}>
							{targetSummary}
						</span>
					</div>
					<button
						type="button"
						className="flex size-24 flex-none cursor-pointer items-center justify-center rounded-6 border-0 bg-transparent p-0 text-ink-muted hover:bg-hover"
						aria-label={isRunning ? t("magicAction.minimize") : t("magicAction.close")}
						title={isRunning ? t("magicAction.minimize") : t("magicAction.close")}
						onClick={dismissMagicActionDialog}
					>
						{/* Figma Icon/close/14: a 14px X at a 1.28 stroke (the shared CloseIcon is a 10px glyph for tabs and chips). */}
						{isRunning ? <Minus size={14} strokeWidth={1.5} aria-hidden="true" /> : <X size={14} strokeWidth={1.3} aria-hidden="true" />}
					</button>
				</div>
				{body}
				<div className="flex flex-wrap items-center justify-end gap-8">{footerActions}</div>
			</div>
		</div>
	);
}
