/** Colour roles of the Markdown source pane (the reference's 원본 view). */
export type MarkdownTokenKind = "text" | "mark" | "heading" | "list" | "strong" | "code" | "quote" | "table";

export interface MarkdownToken {
	readonly kind: MarkdownTokenKind;
	readonly text: string;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s/;
const ORDERED = /^\s*\d+[.)]\s/;
const BULLET = /^\s*[-*+]\s/;
const INLINE = /(\*\*|__)(.+?)\1|(`+)(.+?)\3|([^*_`]+|[*_`])/g;

/** Bold and inline code inside a line of prose; everything else is `base`. */
function inline(text: string, base: MarkdownTokenKind): MarkdownToken[] {
	const tokens: MarkdownToken[] = [];
	for (const match of text.matchAll(INLINE)) {
		const [, strongMark, strong, codeMark, code, plain] = match;
		if (strongMark !== undefined && strong !== undefined) {
			tokens.push({ kind: "mark", text: strongMark }, { kind: "strong", text: strong }, { kind: "mark", text: strongMark });
		} else if (codeMark !== undefined && code !== undefined) {
			tokens.push({ kind: "mark", text: codeMark }, { kind: "code", text: code }, { kind: "mark", text: codeMark });
		} else if (plain !== undefined) {
			const previous = tokens.at(-1);
			if (previous?.kind === base) tokens[tokens.length - 1] = { kind: base, text: previous.text + plain };
			else tokens.push({ kind: base, text: plain });
		}
	}
	return tokens;
}

/**
 * Colours one source line. `fenced` says whether the line sits inside a fenced
 * code block; the result carries the state for the next line.
 */
export function markdownLine(line: string, fenced: boolean): { readonly tokens: readonly MarkdownToken[]; readonly fenced: boolean } {
	const fence = FENCE.exec(line);
	if (fence !== null) {
		const marker = line.slice(0, fence[0].length);
		const rest = line.slice(marker.length);
		return { tokens: rest === "" ? [{ kind: "mark", text: marker }] : [{ kind: "mark", text: marker }, { kind: "code", text: rest }], fenced: !fenced };
	}
	if (fenced) return { tokens: [{ kind: "code", text: line }], fenced };
	const heading = HEADING.exec(line);
	if (heading !== null) return { tokens: [{ kind: "mark", text: heading[0] }, { kind: "heading", text: line.slice(heading[0].length) }], fenced };
	const list = ORDERED.exec(line) ?? BULLET.exec(line);
	if (list !== null) return { tokens: [{ kind: "list", text: list[0] }, ...inline(line.slice(list[0].length), "text")], fenced };
	if (line.startsWith(">")) {
		const marker = line.startsWith("> ") ? "> " : ">";
		return { tokens: [{ kind: "mark", text: marker }, { kind: "quote", text: line.slice(marker.length) }], fenced };
	}
	if (line.trimStart().startsWith("|")) {
		const tokens = line
			.split(/(\|)/)
			.filter((part) => part !== "")
			.map((part): MarkdownToken => ({ kind: part === "|" ? "table" : /^[\s:-]+$/.test(part) ? "mark" : "text", text: part }));
		return { tokens, fenced };
	}
	return { tokens: inline(line, "text"), fenced };
}

export interface MarkdownStats {
	readonly lines: number;
	readonly words: number;
	readonly headings: number;
	readonly tables: number;
	readonly codeBlocks: number;
}

/** The footer facts: lines (a final newline does not add one), words, and block counts. */
export function markdownStats(source: string): MarkdownStats {
	const lines = source.split(/\r\n|\r|\n/);
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	let fenced = false;
	let headings = 0;
	let tables = 0;
	let codeBlocks = 0;
	let inTable = false;
	for (const line of lines) {
		if (FENCE.test(line)) {
			if (!fenced) codeBlocks += 1;
			fenced = !fenced;
			inTable = false;
			continue;
		}
		if (fenced) continue;
		if (HEADING.test(line)) headings += 1;
		const row = line.trimStart().startsWith("|");
		if (row && !inTable) tables += 1;
		inTable = row;
	}
	const words = lines.join(" ").replace(/[#*`|>-]/g, " ").split(/\s+/).filter((word) => word !== "").length;
	return { lines: lines.length, words, headings, tables, codeBlocks };
}
