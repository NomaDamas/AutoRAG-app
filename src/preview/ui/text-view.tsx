import { useEffect, useState, type ReactElement } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked } from "marked";
import type { PreviewDocument } from "../shared/contract";
import { decodeUtf8 } from "../shared/text-sample";
import { rtfToText } from "../shared/rtf";
import { FallbackView, Status } from "./fallback";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	json: "json",
	jsonc: "json",
	xml: "xml",
	html: "xml",
	css: "css",
	scss: "css",
	less: "css",
	py: "python",
	pyw: "python",
	go: "go",
	rs: "rust",
	java: "java",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hh: "cpp",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	sql: "sql",
	yml: "yaml",
	yaml: "yaml",
	rb: "ruby",
	php: "php",
	toml: "ini",
	ini: "ini",
	cfg: "ini",
	conf: "ini",
};

const HIGHLIGHT_STYLE =
	"body{margin:0;padding:20px 24px;background:#fff;color:#1a1a2e;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}" +
	".hljs-keyword,.hljs-selector-tag{color:#d64545}.hljs-string,.hljs-attr{color:#15803d}" +
	".hljs-number,.hljs-literal{color:#7c6f00}.hljs-comment{color:#6e6e80}.hljs-title,.hljs-function{color:#3a46b0}";

function plainText(file: PreviewDocument): string | null {
	if (file.bytes === null) return null;
	return decodeUtf8(file.bytes);
}

export function TextView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const text = plainText(file);
	const [html, setHtml] = useState<string | null>(null);
	const language = LANGUAGE_BY_EXT[file.ext] ?? "";
	useEffect(() => {
		if (text === null || language === "") {
			setHtml(null);
			return;
		}
		setHtml(hljs.highlight(text, { language }).value);
	}, [text, language]);
	if (text === null) return <FallbackView file={file} note="텍스트를 읽지 못했습니다" />;
	if (html !== null) {
		const srcdoc = `<!doctype html><meta charset="utf-8"><style>${HIGHLIGHT_STYLE}</style><pre>${html}</pre>`;
		return <iframe className="ql__frame flex-1 self-stretch w-full h-full border-0 bg-window" sandbox="" title={file.name} srcDoc={srcdoc} />;
	}
	return (
		<pre className="ql__pre box-border self-stretch w-full h-auto m-0 px-24 py-20 bg-window text-ink font-mono text-meta leading-[1.55] whitespace-pre-wrap [word-break:break-word] select-text">
			{text}
			{file.truncated ? "\n\n… 파일이 너무 커서 앞부분만 보여 줍니다" : ""}
		</pre>
	);
}

export function MarkdownView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const text = plainText(file);
	const [srcdoc, setSrcdoc] = useState<string | null>(null);
	useEffect(() => {
		if (text === null) return;
		let cancelled = false;
		Promise.resolve(marked.parse(text, { async: false }))
			.then((html) => {
				if (cancelled || typeof html !== "string") return;
				setSrcdoc(
					`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:28px 36px;font:15px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a2e}pre,code{font-family:ui-monospace,Menlo,monospace;background:#f4f4f7}pre{padding:12px;overflow:auto}img{max-width:100%}</style>${html}`,
				);
			})
			.catch((caught: unknown) => {
				if (cancelled) return;
				setSrcdoc(null);
				if (!(caught instanceof Error)) throw caught;
			});
		return () => {
			cancelled = true;
		};
	}, [text]);
	if (text === null) return <FallbackView file={file} note="문서를 읽지 못했습니다" />;
	if (srcdoc === null) return <Status>불러오는 중</Status>;
	return <iframe className="ql__frame flex-1 self-stretch w-full h-full border-0 bg-window" sandbox="" title={file.name} srcDoc={srcdoc} />;
}

export function HtmlView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const text = plainText(file);
	if (text === null) return <FallbackView file={file} note="문서를 읽지 못했습니다" />;
	return <iframe className="ql__frame flex-1 self-stretch w-full h-full border-0 bg-window" sandbox="" title={file.name} srcDoc={text} />;
}

export function RtfView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const text = plainText(file);
	if (text === null) return <FallbackView file={file} note="문서를 읽지 못했습니다" />;
	return <pre className="ql__pre box-border self-stretch w-full h-auto m-0 px-24 py-20 bg-window text-ink font-mono text-meta leading-[1.55] whitespace-pre-wrap [word-break:break-word] select-text">{rtfToText(text)}</pre>;
}
