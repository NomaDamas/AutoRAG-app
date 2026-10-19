import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { decodeText, lineEnding, splitHighlighted, type TextEncodingName } from "../shared/code";
import { prettyJsonLines } from "../shared/jsonl";
import { bplistToXml, isBinaryPlist } from "../shared/plist";
import type { PreviewDocument } from "../shared/contract";
import { formatFinderSize } from "../shared/format";
import { SMALL_BUTTON, Segmented, TOOL_BUTTON, ToolbarSlot, useChrome } from "./chrome";
import { FallbackView } from "./fallback";
import { CopyIcon, DesktopIcon, MobileIcon, SourceIcon, WrapIcon } from "./icons";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

/** A grammar, the footer's name for it, and its dot (GitHub Linguist colours; Python's is the reference's). */
interface Language {
	readonly grammar: string | null;
	readonly label: string;
	readonly dot: string;
}

const PLAIN: Language = { grammar: null, label: "Plain Text", dot: "#8e8e93" };

const LANGUAGES: Readonly<Record<string, Language>> = {
	py: { grammar: "python", label: "Python 3", dot: "#f2b134" },
	pyw: { grammar: "python", label: "Python 3", dot: "#f2b134" },
	js: { grammar: "javascript", label: "JavaScript", dot: "#f1e05a" },
	jsx: { grammar: "javascript", label: "JavaScript", dot: "#f1e05a" },
	mjs: { grammar: "javascript", label: "JavaScript", dot: "#f1e05a" },
	cjs: { grammar: "javascript", label: "JavaScript", dot: "#f1e05a" },
	ts: { grammar: "typescript", label: "TypeScript", dot: "#3178c6" },
	tsx: { grammar: "typescript", label: "TypeScript", dot: "#3178c6" },
	mts: { grammar: "typescript", label: "TypeScript", dot: "#3178c6" },
	cts: { grammar: "typescript", label: "TypeScript", dot: "#3178c6" },
	json: { grammar: "json", label: "JSON", dot: "#8e8e93" },
	jsonc: { grammar: "json", label: "JSON", dot: "#8e8e93" },
	jsonl: { grammar: "json", label: "JSON Lines", dot: "#8e8e93" },
	ndjson: { grammar: "json", label: "JSON Lines", dot: "#8e8e93" },
	plist: { grammar: "xml", label: "Property List", dot: "#0060ac" },
	xml: { grammar: "xml", label: "XML", dot: "#0060ac" },
	html: { grammar: "xml", label: "HTML", dot: "#e34c26" },
	htm: { grammar: "xml", label: "HTML", dot: "#e34c26" },
	xhtml: { grammar: "xml", label: "HTML", dot: "#e34c26" },
	svg: { grammar: "xml", label: "SVG", dot: "#ff9a00" },
	vue: { grammar: "xml", label: "Vue", dot: "#41b883" },
	svelte: { grammar: "xml", label: "Svelte", dot: "#ff3e00" },
	css: { grammar: "css", label: "CSS", dot: "#663399" },
	scss: { grammar: "css", label: "SCSS", dot: "#c6538c" },
	less: { grammar: "css", label: "Less", dot: "#1d365d" },
	go: { grammar: "go", label: "Go", dot: "#00add8" },
	rs: { grammar: "rust", label: "Rust", dot: "#dea584" },
	java: { grammar: "java", label: "Java", dot: "#b07219" },
	c: { grammar: "c", label: "C", dot: "#555555" },
	h: { grammar: "c", label: "C", dot: "#555555" },
	cpp: { grammar: "cpp", label: "C++", dot: "#f34b7d" },
	cc: { grammar: "cpp", label: "C++", dot: "#f34b7d" },
	cxx: { grammar: "cpp", label: "C++", dot: "#f34b7d" },
	hpp: { grammar: "cpp", label: "C++", dot: "#f34b7d" },
	hh: { grammar: "cpp", label: "C++", dot: "#f34b7d" },
	cs: { grammar: "csharp", label: "C#", dot: "#178600" },
	rb: { grammar: "ruby", label: "Ruby", dot: "#701516" },
	php: { grammar: "php", label: "PHP", dot: "#4f5d95" },
	sh: { grammar: "bash", label: "Shell", dot: "#89e051" },
	bash: { grammar: "bash", label: "Shell", dot: "#89e051" },
	zsh: { grammar: "bash", label: "Shell", dot: "#89e051" },
	sql: { grammar: "sql", label: "SQL", dot: "#e38c00" },
	yml: { grammar: "yaml", label: "YAML", dot: "#cb171e" },
	yaml: { grammar: "yaml", label: "YAML", dot: "#cb171e" },
	toml: { grammar: "ini", label: "TOML", dot: "#9c4221" },
	ini: { grammar: "ini", label: "INI", dot: "#d1dbe0" },
	cfg: { grammar: "ini", label: "INI", dot: "#d1dbe0" },
	conf: { grammar: "ini", label: "INI", dot: "#d1dbe0" },
	kt: { grammar: "kotlin", label: "Kotlin", dot: "#a97bff" },
	kts: { grammar: "kotlin", label: "Kotlin", dot: "#a97bff" },
	swift: { grammar: "swift", label: "Swift", dot: "#f05138" },
	lua: { grammar: "lua", label: "Lua", dot: "#000080" },
	diff: { grammar: "diff", label: "Diff", dot: "#8e8e93" },
	patch: { grammar: "diff", label: "Diff", dot: "#8e8e93" },
};

/** highlight.js runs on at most this much text; the rest of a long file stays plain. */
const HIGHLIGHT_CAP = 512 * 1024;
/** Lines rendered per chunk; a chunk renders once it scrolls within reach. */
const CHUNK_LINES = 400;
/** Panel sizes from the reference: code 840 wide; HTML a 980 × 720 page (674 below the toolbar). */
const CODE_WIDTH = 840;
const HTML_SIZE = { width: 980, height: 674 } as const;
/** Vertical chrome around the code lines: 12 + 18 padding and the 30px footer. */
const CODE_CHROME = 12 + 18 + 30;

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** One HTML string per line: highlighted up to the cap, escaped plain text after it. */
function highlightLines(text: string, grammar: string | null): readonly string[] {
	if (grammar === null) {
		const lines = text.split("\n");
		if (lines.length > 1 && lines.at(-1) === "") lines.pop();
		return lines.map(escapeHtml);
	}
	const cut = text.length <= HIGHLIGHT_CAP ? text.length : text.lastIndexOf("\n", HIGHLIGHT_CAP) + 1;
	const head = splitHighlighted(hljs.highlight(text.slice(0, cut), { language: grammar, ignoreIllegals: true }).value);
	if (cut >= text.length) return head;
	return [...head, ...highlightLines(text.slice(cut), null)];
}

function LineChunk({ lines, start }: { readonly lines: readonly string[]; readonly start: number }): ReactElement {
	const ref = useRef<HTMLDivElement | null>(null);
	const [shown, setShown] = useState(start === 0);
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
	const html = useMemo(
		() => (shown ? lines.map((line, index) => `<div class="ql-line"><span class="ql-ln">${start + index + 1}</span><span class="ql-lc">${line === "" ? " " : line}</span></div>`).join("") : ""),
		[shown, lines, start],
	);
	if (!shown) return <div ref={ref} className="ql-chunk" style={{ height: `calc(${lines.length} * 1lh)` }} />;
	return <div ref={ref} className="ql-chunk" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Numbered lines of already-escaped HTML. Long files render in chunks as they
 * scroll near, so opening a 100k-line log costs one chunk, not the file.
 */
export function LineList({ lines }: { readonly lines: readonly string[] }): ReactElement {
	const chunks = useMemo(() => {
		const out: { readonly start: number; readonly lines: readonly string[] }[] = [];
		for (let start = 0; start < lines.length; start += CHUNK_LINES) out.push({ start, lines: lines.slice(start, start + CHUNK_LINES) });
		return out;
	}, [lines]);
	return (
		<>
			{chunks.map((chunk) => (
				<LineChunk key={chunk.start} start={chunk.start} lines={chunk.lines} />
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
export function TextView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const decoded = useDecodedText(file);
	if (decoded === null) return <FallbackView file={file} note={t("quickLook.code.readFailed")} />;
	return <CodeBody file={file} decoded={decoded} sizeNote={null} />;
}

/**
 * The numbered, highlighted lines with the toolbar and footer `TextView` shows.
 * `sizeNote` replaces the footer's size label when the viewer cut the text
 * itself (JSON Lines stops after a record count, not a byte count).
 */
export function CodeBody({ file, decoded, sizeNote }: { readonly file: PreviewDocument; readonly decoded: DecodedText; readonly sizeNote: string | null }): ReactElement {
	const { t, i18n } = useTranslation();
	const { report } = useChrome();
	const language = LANGUAGES[file.ext] ?? PLAIN;
	const lines = useMemo(() => highlightLines(decoded.text, language.grammar), [decoded, language.grammar]);
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
					<LineList lines={lines} />
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
