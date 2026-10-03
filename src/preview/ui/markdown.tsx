import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { marked } from "marked";
import type { PreviewDocument } from "../shared/contract";
import { markdownLine, markdownStats } from "../shared/markdown-source";
import { Segmented, ToolbarSlot, useChrome } from "./chrome";
import { escapeHtml, LineList, useDecodedText } from "./code";
import { FallbackView } from "./fallback";
import { sanitizeMarkdownHtml } from "./markdown-html";

type MarkdownMode = "source" | "split" | "preview";

const MODES = [
	{ value: "source", label: "원본" },
	{ value: "split", label: "나란히" },
	{ value: "preview", label: "렌더링" },
] as const;

/** The reference panel is 1100 wide; the height follows the longer pane. */
const MARKDOWN_WIDTH = 1100;
/** Source pane padding (16 + 24); the rendered article carries its own. */
const SOURCE_PADDING = 16 + 24;
/** The 28px footer and the hairlines above the panes and the footer. */
const MARKDOWN_CHROME = 28 + 1;

function sourceLines(text: string): readonly string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	let fenced = false;
	return lines.map((line) => {
		const colored = markdownLine(line, fenced);
		fenced = colored.fenced;
		return colored.tokens.map((token) => `<span class="ql-md-${token.kind}">${escapeHtml(token.text)}</span>`).join("");
	});
}

function folderOf(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut <= 0 ? path.slice(0, cut + 1) : path.slice(0, cut);
}

/** Links stay inert: the preview never navigates, so a click must not try to. */
function holdLinks(event: MouseEvent<HTMLElement>): void {
	if (event.target instanceof Element && event.target.closest("a") !== null) event.preventDefault();
}

/**
 * Markdown as the reference shows it: coloured source and the rendered page
 * side by side (or either alone), with a footer counting lines, words,
 * headings, tables, and code blocks.
 */
export function MarkdownView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { report } = useChrome();
	const decoded = useDecodedText(file);
	const [mode, setMode] = useState<MarkdownMode>("split");
	const source = useMemo(() => (decoded === null ? [] : sourceLines(decoded.text)), [decoded]);
	const html = useMemo(() => {
		if (decoded === null) return "";
		const rendered = marked.parse(decoded.text, { async: false, gfm: true });
		return sanitizeMarkdownHtml(typeof rendered === "string" ? rendered : "", folderOf(file.path));
	}, [decoded, file.path]);
	const stats = useMemo(() => (decoded === null ? null : markdownStats(decoded.text)), [decoded]);
	// The window still has the previous file's size here, so measure the content, not the scrolling panes.
	const sourceRef = useRef<HTMLDivElement | null>(null);
	const previewRef = useRef<HTMLElement | null>(null);
	useLayoutEffect(() => {
		const source = sourceRef.current === null ? 0 : sourceRef.current.offsetHeight + SOURCE_PADDING;
		const tallest = Math.max(source, previewRef.current?.offsetHeight ?? 0);
		if (tallest > 0) report({ width: MARKDOWN_WIDTH, height: tallest + MARKDOWN_CHROME }, "clamp");
	}, [report, html, source]);
	if (decoded === null || stats === null) return <FallbackView file={file} note="문서를 읽지 못했습니다" />;
	const blocks = [`제목 ${stats.headings}`, `표 ${stats.tables}`, `코드 블록 ${stats.codeBlocks}`].join(" · ");
	return (
		<>
			<ToolbarSlot>
				<Segmented label="보기 방식" options={MODES} value={mode} onChange={setMode} />
			</ToolbarSlot>
			<div className="ql-markdown flex flex-1 min-h-0 border-t-[0.5px] border-ql-hairline">
				{mode === "preview" ? null : (
					<div className="ql-lines ql-lines--markdown flex-1 basis-0 min-w-0 overflow-auto pt-16 pb-24 bg-ql-sunk font-ql-mono text-[12.5px] leading-[1.7] select-text" data-wrap>
						<div ref={sourceRef}>
							<LineList lines={source} />
						</div>
					</div>
				)}
				{mode === "split" ? <div className="flex-none w-[0.5px] bg-ql-hairline" /> : null}
				{mode === "source" ? null : (
					<div className="flex-1 basis-0 min-w-0 overflow-auto bg-ql-paper">
						<article ref={previewRef} className="ql-md max-w-640 mx-auto px-32 pt-22 pb-40 select-text" onClick={holdLinks} dangerouslySetInnerHTML={{ __html: html }} />
					</div>
				)}
			</div>
			<footer className="flex flex-none items-center gap-14 h-28 px-16 border-t-[0.5px] border-ql-hairline text-ql-ink-secondary text-[11.5px] whitespace-nowrap">
				<span className="font-semibold text-ql-ink">Markdown</span>
				<span>{stats.lines.toLocaleString("ko-KR")}줄</span>
				<span>{stats.words.toLocaleString("ko-KR")}단어</span>
				<span className="flex-1" />
				<span>{blocks}</span>
			</footer>
		</>
	);
}
