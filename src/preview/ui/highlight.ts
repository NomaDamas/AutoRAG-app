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
import { splitHighlighted } from "../shared/code";

/**
 * The one highlight.js setup of the app: Quick Look's code views and the code
 * blocks of AI Search answers and evidence excerpts share these grammars, so
 * they colour the same source the same way (see `syntax.css`).
 */

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
export interface Language {
	readonly grammar: string | null;
	readonly label: string;
	readonly dot: string;
}

export const PLAIN: Language = { grammar: null, label: "Plain Text", dot: "#8e8e93" };

/** Languages by file extension. */
export const LANGUAGES: Readonly<Record<string, Language>> = {
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

/** Names a code fence uses that are neither a file extension nor a highlight.js alias. */
const FENCE_ALIASES: Readonly<Record<string, string>> = {
	shell: "bash",
	console: "bash",
	terminal: "bash",
	"shell-session": "bash",
};

/**
 * The registered grammar for a code fence's language word (`python`, `py`,
 * `TSX`, `shell`, `yml`...), or null when the fence names none or one the app
 * has no grammar for. File extensions and highlight.js aliases both resolve.
 */
export function highlightGrammar(language: string | null): string | null {
	const name = language?.trim().toLowerCase() ?? "";
	if (name === "") return null;
	if (Object.hasOwn(FENCE_ALIASES, name)) return FENCE_ALIASES[name] ?? null;
	if (Object.hasOwn(LANGUAGES, name)) return LANGUAGES[name]?.grammar ?? null;
	return hljs.getLanguage(name) === undefined ? null : name;
}

/** highlight.js runs on at most this much text; the rest of a long file stays plain. */
const HIGHLIGHT_CAP = 512 * 1024;

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** One HTML string per line: highlighted up to the cap, escaped plain text after it. */
export function highlightLines(text: string, grammar: string | null): readonly string[] {
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

/**
 * Escaped, highlighted HTML for a code block whose fence named `language`.
 * Safe to set as `innerHTML`: every character of the source is escaped, and
 * the only markup is highlight.js's own `<span class>` tokens.
 */
export function highlightCode(text: string, language: string | null): string {
	return highlightLines(text, highlightGrammar(language)).join("\n");
}
