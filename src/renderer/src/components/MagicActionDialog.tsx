import { Check, Copy, Minus, Terminal } from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dismissMagicActionDialog, stopMagicActionRun, useMagicActionSession } from "../hooks/useMagicAction";
import { cn } from "../lib/cn";
import { parseAnswerBlocks, parseInline, type InlineSegment } from "../state/answer-markdown";
import { basename } from "../state/paths";
import { CloseIcon, SparklesIcon } from "./icons";

const BUTTON =
	"inline-flex h-30 flex-none cursor-pointer items-center justify-center gap-6 rounded-6 border px-12 text-meta transition-colors duration-(--dur-color) ease-out";
const SECONDARY = "border-border bg-window text-ink hover:bg-hover";
const PRIMARY = "border-transparent bg-accent font-medium text-on-accent hover:bg-accent-hover";

function Button({
	primary = false,
	onClick,
	children,
	dataAction,
}: {
	readonly primary?: boolean;
	readonly onClick: () => void;
	readonly children: ReactNode;
	readonly dataAction?: string;
}): ReactElement {
	return (
		<button type="button" data-action={dataAction} className={cn(BUTTON, primary ? PRIMARY : SECONDARY)} onClick={onClick}>
			{children}
		</button>
	);
}

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
		<div className="flex flex-col gap-8 text-left text-meta leading-relaxed text-ink-body" data-testid="magic-action-output">
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
						<p key={idx} className="m-0 font-semibold text-ink">
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

	useEffect(() => {
		setCopied(false);
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
					<div className="max-h-[46vh] overflow-y-auto rounded-8 border border-border bg-chrome p-12">
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
		body = (
			<div className="max-h-[52vh] overflow-y-auto rounded-8 border border-border bg-chrome p-12">
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
				{output.length > 0 ? (
					<Button dataAction="copy-magic-action-output" onClick={() => copyOutput(output)}>
						{copied ? <Check size={13} /> : <Copy size={13} />}
						<span>{copied ? t("magicAction.copied") : t("magicAction.copyOutput")}</span>
					</Button>
				) : null}
				<Button primary dataAction="close-magic-action" onClick={dismissMagicActionDialog}>
					{t("magicAction.close")}
				</Button>
			</>
		);
	} else if (run.status === "failed") {
		body = (
			<div className="flex flex-col gap-8">
				<strong className="text-meta font-semibold text-danger-text">{t("magicAction.failedTitle")}</strong>
				<pre
					className="m-0 max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded-8 border border-danger-border bg-danger-bg-soft p-12 font-mono text-badge text-danger-text"
					role="alert"
					data-testid="magic-action-error"
				>
					{run.message}
				</pre>
			</div>
		);
		footerActions = (
			<Button primary dataAction="close-magic-action" onClick={dismissMagicActionDialog}>
				{t("magicAction.close")}
			</Button>
		);
	} else if (run.status === "stopped") {
		body = (
			<p className="m-0 text-meta text-ink-muted">{t("magicAction.stoppedTitle")}</p>
		);
		footerActions = (
			<Button primary dataAction="close-magic-action" onClick={dismissMagicActionDialog}>
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
				className="flex max-h-[84vh] w-[520px] max-w-[92vw] flex-col gap-14 overflow-hidden rounded-12 border border-border bg-window p-18 shadow-menu animate-[rise_var(--dur-menu)_var(--ease-out)]"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				data-testid="magic-action-dialog"
			>
				<div className="flex items-center justify-between gap-8">
					<div className="flex min-w-0 items-center gap-8">
						<span className="flex size-24 flex-none items-center justify-center rounded-6 bg-accent-soft text-accent">
							{isScript ? <Terminal size={13} strokeWidth={2} /> : <SparklesIcon />}
						</span>
						<div className="flex min-w-0 flex-col">
							<strong className="truncate text-[13px] font-semibold text-ink">{title}</strong>
							<span className="truncate text-badge text-ink-muted" title={paths.join("\n")}>
								{targetSummary}
							</span>
						</div>
					</div>
					<button
						type="button"
						className="flex size-24 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-ink-muted hover:bg-hover-strong"
						aria-label={isRunning ? t("magicAction.minimize") : t("magicAction.close")}
						title={isRunning ? t("magicAction.minimize") : t("magicAction.close")}
						onClick={dismissMagicActionDialog}
					>
						{isRunning ? <Minus size={14} strokeWidth={2.4} /> : <CloseIcon />}
					</button>
				</div>
				{body}
				<div className="flex flex-wrap items-center justify-end gap-8">{footerActions}</div>
			</div>
		</div>
	);
}
