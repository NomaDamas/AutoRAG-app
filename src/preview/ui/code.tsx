import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { decodeText, lineEnding, type TextEncodingName } from "../shared/code";
import { prettyJsonLines } from "../shared/jsonl";
import { bplistToXml, isBinaryPlist } from "../shared/plist";
import type { PreviewDocument } from "../shared/contract";
import { formatFinderSize } from "../shared/format";
import { locateLines } from "../shared/text-marks";
import { SMALL_BUTTON, Segmented, TOOL_BUTTON, ToolbarSlot, useChrome } from "./chrome";
import { FallbackView } from "./fallback";
import { CopyIcon, DesktopIcon, MobileIcon, SourceIcon, WrapIcon } from "./icons";
import { highlightLines, LANGUAGES, PLAIN } from "./highlight";

/** Lines rendered per chunk; a chunk renders once it scrolls within reach. */
const CHUNK_LINES = 400;
/** Panel sizes from the reference: code 840 wide; HTML a 980 × 720 page (674 below the toolbar). */
const CODE_WIDTH = 840;
const HTML_SIZE = { width: 980, height: 674 } as const;
/** Vertical chrome around the code lines: 12 + 18 padding and the 30px footer. */
const CODE_CHROME = 12 + 18 + 30;

function LineChunk({
	lines,
	start,
	marked,
	firstMarked,
}: {
	readonly lines: readonly string[];
	readonly start: number;
	readonly marked: ReadonlySet<number>;
	readonly firstMarked: number | undefined;
}): ReactElement {
	const ref = useRef<HTMLDivElement | null>(null);
	const hasMark = useMemo(() => lines.some((_line, index) => marked.has(start + index)), [lines, start, marked]);
	const [shown, setShown] = useState(start === 0 || hasMark);
	useEffect(() => {
		if (hasMark) setShown(true);
	}, [hasMark]);
	useEffect(() => {
		const node = ref.current;
		if (shown || node === null) return;
		const root = node.closest(".ql-lines");
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setShown(true);
			},
			{ root: root instanceof HTMLElement ? root : null, rootMargin: "1600px 0px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [shown]);
	useLayoutEffect(() => {
		if (!shown || firstMarked === undefined || firstMarked < start || firstMarked >= start + lines.length) return;
		const row = ref.current?.querySelector<HTMLElement>('[data-evidence-mark="first"]');
		const scroller = row?.closest<HTMLElement>(".ql-lines");
		if (row === null || row === undefined || scroller === null || scroller === undefined) return;
		scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight * 0.25);
	}, [shown, firstMarked, start, lines.length]);
	const html = useMemo(
		() =>
			shown
				? lines
						.map((line, index) => {
							const lineIndex = start + index;
							const mark = marked.has(lineIndex) ? ` ql-line--marked" data-evidence-mark="${lineIndex === firstMarked ? "first" : "rest"}` : "";
							return `<div class="ql-line${mark}"><span class="ql-ln">${lineIndex + 1}</span><span class="ql-lc">${line === "" ? " " : line}</span></div>`;
						})
						.join("")
				: "",
		[shown, lines, start, marked, firstMarked],
	);
	if (!shown) return <div ref={ref} className="ql-chunk" style={{ height: `calc(${lines.length} * 1lh)` }} />;
	return <div ref={ref} className="ql-chunk" dangerouslySetInnerHTML={{ __html: html }} />;
}

const NO_MARKS: ReadonlySet<number> = new Set();

/**
 * Numbered lines of already-escaped HTML. Long files render in chunks as they
 * scroll near, so opening a 100k-line log costs one chunk, not the file. A
 * chunk holding a `marked` line renders up front and scrolls its first mark into view.
 */
export function LineList({ lines, marked = NO_MARKS }: { readonly lines: readonly string[]; readonly marked?: ReadonlySet<number> }): ReactElement {
	const firstMarked = useMemo(() => {
		const [first] = marked;
		return first;
	}, [marked]);
	const chunks = useMemo(() => {
		const out: { readonly start: number; readonly lines: readonly string[] }[] = [];
		for (let start = 0; start < lines.length; start += CHUNK_LINES) out.push({ start, lines: lines.slice(start, start + CHUNK_LINES) });
		return out;
	}, [lines]);
	return (
		<>
			{chunks.map((chunk) => (
				<LineChunk key={chunk.start} start={chunk.start} lines={chunk.lines} marked={marked} firstMarked={firstMarked} />
			))}
		</>
	);
}

export interface DecodedText {
	readonly text: string;
	readonly encoding: TextEncodingName;
	readonly ending: "LF" | "CRLF" | "CR";
}

/** Decodes the preview bytes once and normalizes line breaks to `\n`. */
export function useDecodedText(file: PreviewDocument): DecodedText | null {
	return useMemo(() => {
		if (file.bytes === null) return null;
		const { text, encoding } = decodeText(file.bytes);
		return { text: text.replace(/\r\n?/g, "\n"), encoding, ending: lineEnding(text) };
	}, [file.bytes]);
}

/** Copies `text` and flips the label to 복사됨 for a moment. */
function useCopy(text: string): { readonly copied: boolean; readonly copy: () => void } {
	const { bridge } = useChrome();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return { copied, copy: () => void bridge.copyText(text).then(() => setCopied(true)) };
}

const FOOTER = "flex flex-none items-center gap-14 px-16 border-t-[0.5px] border-ql-hairline text-ql-ink-secondary text-[11.5px] whitespace-nowrap";

/**
 * Code and plain text, like the reference's `.py` panel: numbered lines with
 * Xcode-style colours on the paper material, wrap and copy in the toolbar,
 * and a footer with language, encoding, line ending, and line count.
 */
export function TextView({ file, anchor = null }: { readonly file: PreviewDocument; readonly anchor?: readonly string[] | null }): ReactElement {
	const { t } = useTranslation();
	const decoded = useDecodedText(file);
	if (decoded === null) return <FallbackView file={file} note={t("quickLook.code.readFailed")} />;
	return <CodeBody file={file} decoded={decoded} sizeNote={null} anchor={anchor} />;
}

/**
 * The numbered, highlighted lines with the toolbar and footer `TextView` shows.
 * `sizeNote` replaces the footer's size label when the viewer cut the text
 * itself (JSON Lines stops after a record count, not a byte count).
 */
export function CodeBody({
	file,
	decoded,
	sizeNote,
	anchor = null,
}: {
	readonly file: PreviewDocument;
	readonly decoded: DecodedText;
	readonly sizeNote: string | null;
	readonly anchor?: readonly string[] | null;
}): ReactElement {
	const { t, i18n } = useTranslation();
	const { report } = useChrome();
	const language = LANGUAGES[file.ext] ?? PLAIN;
	const lines = useMemo(() => highlightLines(decoded.text, language.grammar), [decoded, language.grammar]);
	const marked = useMemo(() => (anchor === null || anchor.length === 0 ? NO_MARKS : locateLines(decoded.text, anchor)), [decoded.text, anchor]);
	const [wrap, setWrap] = useState(true);
	const { copied, copy } = useCopy(decoded.text);
	// The window still has the previous file's size here, so measure the lines themselves, not the scroller.
	const contentRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const content = contentRef.current;
		if (content === null) return;
		report({ width: CODE_WIDTH, height: content.offsetHeight + CODE_CHROME }, "clamp");
	}, [report, lines]);
	const size = sizeNote ?? (file.truncated ? t("quickLook.code.truncated", { size: formatFinderSize(file.bytes?.byteLength ?? 0) }) : formatFinderSize(file.size));
	return (
		<>
			<ToolbarSlot>
				<button type="button" className={TOOL_BUTTON} aria-label={t("quickLook.code.wrap")} title={t("quickLook.code.wrap")} aria-pressed={wrap} onClick={() => setWrap((current) => !current)}>
					<WrapIcon />
				</button>
				<button type="button" className={SMALL_BUTTON} aria-label={t("quickLook.code.copy")} onClick={copy}>
					<CopyIcon />
					{copied ? t("quickLook.fallback.copied") : t("quickLook.fallback.copy")}
				</button>
			</ToolbarSlot>
			<div className="ql-lines ql-lines--code flex-1 min-h-0 overflow-auto pt-12 pb-18 bg-ql-paper font-ql-mono text-[12.5px] leading-[1.62] select-text" data-wrap={wrap}>
				<div ref={contentRef}>
					<LineList lines={lines} marked={marked} />
				</div>
			</div>
			<footer className={`${FOOTER} h-30`}>
				<span className="flex items-center gap-6 font-semibold text-ql-ink">
					<span className="w-8 h-8 rounded-2" style={{ background: language.dot }} />
					{language.label}
				</span>
				<span>{decoded.encoding}</span>
				<span>{decoded.ending}</span>
				<span>{t("quickLook.code.lines", { count: lines.length.toLocaleString(i18n.language) })}</span>
				<span className="flex-1" />
				{anchor === null || anchor.length === 0 ? null : (
					<span className="ql-code__evidence" data-evidence-state={marked.size > 0 ? "found" : "missing"}>
						{marked.size > 0 ? t("quickLook.evidence.found") : t("quickLook.evidence.missing")}
					</span>
				)}
				<span>{size}</span>
			</footer>
		</>
	);
}

/** Records the JSON Lines view pretty-prints before it stops. */
const JSONL_RECORD_LIMIT = 2000;

/** JSON Lines: the first records as indented, highlighted JSON. */
export function JsonLinesView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t, i18n } = useTranslation();
	const decoded = useDecodedText(file);
	const shown = useMemo(() => {
		if (decoded === null) return null;
		const records = prettyJsonLines(decoded.text, JSONL_RECORD_LIMIT);
		return { decoded: { ...decoded, text: records.text }, cut: records.cut };
	}, [decoded]);
	if (shown === null) return <FallbackView file={file} note={t("quickLook.code.readFailed")} />;
	const sizeNote = shown.cut ? t("quickLook.code.firstRecords", { count: JSONL_RECORD_LIMIT.toLocaleString(i18n.language) }) : null;
	return <CodeBody file={file} decoded={shown.decoded} sizeNote={sizeNote} />;
}

/** Property lists as XML text; a binary plist is converted first, as `plutil -convert xml1` would. */
export function PlistView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const shown = useMemo<{ readonly decoded: DecodedText } | { readonly error: string } | null>(() => {
		if (bytes === null) return null;
		if (!isBinaryPlist(bytes)) {
			const { text, encoding } = decodeText(bytes);
			return { decoded: { text: text.replace(/\r\n?/g, "\n"), encoding, ending: lineEnding(text) } };
		}
		try {
			return { decoded: { text: bplistToXml(bytes), encoding: "UTF-8", ending: "LF" } };
		} catch (caught) {
			return { error: caught instanceof Error ? caught.message : t("quickLook.code.plistInvalid") };
		}
	}, [bytes, t]);
	if (shown === null) return <FallbackView file={file} note={t("quickLook.code.readFailed")} />;
	if ("error" in shown) return <FallbackView file={file} note={shown.error} />;
	return <CodeBody file={file} decoded={shown.decoded} sizeNote={isBinaryPlist(bytes ?? new Uint8Array()) ? t("quickLook.code.plistConverted") : null} />;
}

type HtmlMode = "desktop" | "mobile" | "source";

const HTML_MODES = [
	{ value: "desktop", labelKey: "quickLook.code.modes.desktop", icon: <DesktopIcon /> },
	{ value: "mobile", labelKey: "quickLook.code.modes.mobile", icon: <MobileIcon /> },
	{ value: "source", labelKey: "quickLook.code.modes.source", icon: <SourceIcon /> },
] as const;

/**
 * HTML, rendered in a sandboxed frame with scripts off, at desktop width or
 * in a 390px phone column, or as highlighted source.
 */
export function HtmlView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t, i18n } = useTranslation();
	const { report } = useChrome();
	const decoded = useDecodedText(file);
	const [mode, setMode] = useState<HtmlMode>("desktop");
	const source = useMemo(() => (decoded === null || mode !== "source" ? [] : highlightLines(decoded.text, "xml")), [decoded, mode]);
	const modes = useMemo(() => HTML_MODES.map((option) => ({ value: option.value, icon: option.icon, label: t(option.labelKey) })), [t, i18n.language]);
	useEffect(() => report(HTML_SIZE, "clamp"), [report]);
	if (decoded === null) return <FallbackView file={file} note={t("quickLook.documents.readFailed")} />;
	const mobile = mode === "mobile";
	return (
		<>
			<ToolbarSlot>
				<Segmented label={t("quickLook.code.viewMode")} options={modes} value={mode} onChange={setMode} />
			</ToolbarSlot>
			{mode === "source" ? (
				<div className="ql-lines ql-lines--html flex-1 min-h-0 overflow-auto py-14 bg-ql-paper font-ql-mono text-[12.5px] leading-[1.65] select-text" data-wrap={false}>
					<LineList lines={source} />
				</div>
			) : (
				<div className={`ql-html flex flex-1 justify-center min-h-0 ${mobile ? "py-20 bg-ql-sunk" : "bg-ql-page"}`}>
					<div className={mobile ? "w-390 h-full overflow-hidden rounded-14 bg-ql-page shadow-ql-phone" : "w-full h-full"}>
						<iframe className="block w-full h-full border-0 bg-ql-page" sandbox="" title={file.name} srcDoc={decoded.text} />
					</div>
				</div>
			)}
		</>
	);
}
