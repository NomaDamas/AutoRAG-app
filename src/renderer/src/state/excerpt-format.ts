/**
 * Format detection for evidence chunks.
 *
 * An evidence excerpt is a chunk: a window cut out of a parsed document, so its
 * markup is rarely whole. A spreadsheet or HWP table arrives as HTML rows with
 * no `<table>` around them, often starting inside a cell (`…</td><td>`) or
 * ending inside a tag (`<td`); a markdown table may have lost its header row.
 * `splitExcerpt` cuts one chunk into parts by format, line by line:
 *
 * - `html`: lines carrying a block-level tag (and lines between them while an
 *   element is still open), repaired by `repairHtmlFragment` so the HTML parser
 *   builds the table it describes instead of dropping its `<tr>`/`<td>` tags.
 *   The renderer still sanitizes it; nothing here makes HTML safe.
 * - `table`: a GFM pipe table, with or without its header and delimiter rows.
 * - `markdown`: everything else, rendered by `parseAnswerBlocks`.
 *
 * Tags inside a code fence or an inline code span are code, not markup.
 */

export type ColumnAlign = "left" | "center" | "right";

export type ExcerptPart =
	| { readonly kind: "markdown"; readonly text: string }
	/** Repaired, unsanitized HTML. */
	| { readonly kind: "html"; readonly html: string }
	| {
			readonly kind: "table";
			/** Null when the chunk starts below the table's header. */
			readonly header: readonly string[] | null;
			readonly align: readonly (ColumnAlign | null)[];
			readonly rows: readonly (readonly string[])[];
	  };

/** Tags that make a line HTML: block structure markdown cannot express inline. */
const BLOCK_TAGS =
	"table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|div|p|ul|ol|li|h[1-6]|blockquote|pre|dl|dt|dd|section|article|header|footer|nav|main|aside|figure|figcaption|details|summary|hr|center";
const BLOCK_TAG = new RegExp(`<(/?)(${BLOCK_TAGS})\\b[^<>]*>`, "giu");
/** Block tags with no closing tag; they never hold a region open. */
const VOID_BLOCK: Partial<Record<string, true>> = { col: true, hr: true };

const FENCE = /^\s*```/u;
const INLINE_CODE = /`[^`]*`/gu;

/** Net change in open block elements across one line; null when the line has no block tag. */
function blockDepthDelta(line: string): number | null {
	let found = false;
	let delta = 0;
	for (const match of line.replace(INLINE_CODE, "").matchAll(BLOCK_TAG)) {
		found = true;
		const tag = (match[2] ?? "").toLowerCase();
		if (VOID_BLOCK[tag] === true || match[0].endsWith("/>")) continue;
		delta += match[1] === "/" ? -1 : 1;
	}
	return found ? delta : null;
}

const DELIMITER_CELL = /^\s*:?-+:?\s*$/u;

/** Cells of one pipe-table line; `\|` is a literal pipe and `\_`, `\*` etc. are markdown escapes. */
function pipeCells(line: string): string[] {
	let body = line.trim();
	if (body.startsWith("|")) body = body.slice(1);
	if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
	return body.split(/(?<!\\)\|/u).map((cell) => cell.trim().replace(/\\([!-/:-@[-`{-~])/gu, "$1"));
}

function isDelimiterRow(line: string): boolean {
	if (!line.includes("-") || !line.includes("|")) return false;
	return pipeCells(line).every((cell) => DELIMITER_CELL.test(cell));
}

function alignOf(cell: string): ColumnAlign | null {
	const trimmed = cell.trim();
	const left = trimmed.startsWith(":");
	const right = trimmed.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	return left ? "left" : null;
}

/** A parsed GFM pipe table. */
export type PipeTablePart = Extract<ExcerptPart, { readonly kind: "table" }>;

/** Length of the pipe table starting at `lines[start]`, or 0 when none starts there. */
export function pipeTableLength(lines: readonly string[], start: number): number {
	const first = lines[start]?.trim() ?? "";
	const second = lines[start + 1]?.trim() ?? "";
	const delimited = first.includes("|") && isDelimiterRow(second);
	if (!delimited && !(first.startsWith("|") && second.startsWith("|"))) return 0;
	let end = start;
	while (end < lines.length) {
		const line = lines[end]?.trim() ?? "";
		if (line.startsWith("|") || (delimited && line.includes("|"))) end += 1;
		else break;
	}
	return end - start;
}

export function pipeTable(lines: readonly string[]): PipeTablePart {
	const delimited = lines.length > 1 && isDelimiterRow(lines[1] ?? "");
	const body = lines.filter((line, index) => !(index === 1 && delimited) && !isDelimiterRow(line)).map(pipeCells);
	const header = delimited ? (body.shift() ?? null) : null;
	const columns = Math.max(header?.length ?? 0, ...body.map((row) => row.length));
	const pad = (row: readonly string[]): string[] => [...row, ...Array<string>(columns - row.length).fill("")];
	const align = delimited ? pad(pipeCells(lines[1] ?? "")).map(alignOf) : Array<ColumnAlign | null>(columns).fill(null);
	return { kind: "table", header: header === null ? null : pad(header), align, rows: body.map(pad) };
}

/** Split one evidence chunk into markdown, HTML, and pipe-table parts. */
export function splitExcerpt(text: string): readonly ExcerptPart[] {
	const lines = text.split("\n");
	const parts: ExcerptPart[] = [];
	let markdown: string[] = [];
	const flushMarkdown = (): void => {
		const joined = markdown.join("\n").replace(/^\n+|\n+$/gu, "");
		if (joined.trim().length > 0) parts.push({ kind: "markdown", text: joined });
		markdown = [];
	};
	let inFence = false;
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (FENCE.test(line)) inFence = !inFence;
		if (inFence || FENCE.test(line)) {
			markdown.push(line);
			index += 1;
			continue;
		}
		const delta = blockDepthDelta(line);
		if (delta !== null) {
			flushMarkdown();
			const region = [line];
			let depth = Math.max(0, delta);
			index += 1;
			while (index < lines.length) {
				const next = lines[index] ?? "";
				if (FENCE.test(next)) break;
				const nextDelta = blockDepthDelta(next);
				if (nextDelta === null && depth === 0) break;
				region.push(next);
				depth = Math.max(0, depth + (nextDelta ?? 0));
				index += 1;
			}
			parts.push({ kind: "html", html: repairHtmlFragment(region.join("\n").trim()) });
			continue;
		}
		const tableLength = pipeTableLength(lines, index);
		if (tableLength > 0) {
			flushMarkdown();
			parts.push(pipeTable(lines.slice(index, index + tableLength)));
			index += tableLength;
			continue;
		}
		markdown.push(line);
		index += 1;
	}
	flushMarkdown();
	return parts;
}

/** The tail of a tag the chunk started inside of: `td>` or `d colspan="2">`. Prose like `a > b` has a space before `>` and no attribute. */
const LEADING_TAG_TAIL = /^[A-Za-z][\w-]*(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=]+))?)*\/?>/u;
/** The head of a tag the chunk ended inside of: `<td` or `</tr`. */
const TRAILING_TAG_HEAD = /<\/?[A-Za-z][^<>]*$/u;
const TAG = /<(\/?)([A-Za-z][\w-]*)\b[^<>]*>/gu;

const TABLE_LEVEL: Partial<Record<string, number>> = { table: 0, thead: 1, tbody: 1, tfoot: 1, tr: 2, td: 3, th: 3 };

/**
 * Make a cut-out HTML fragment parse as the structure it describes. Drops a
 * partial tag at either end, opens the `<table>`/`<tr>`/`<td>` that leading
 * orphan closing tags belong to, wraps rows and cells that have no table (the
 * HTML parser ignores `<tr>` and `<td>` outside one), and closes the table
 * elements still open at the end. Other tags pass through for the parser to
 * balance.
 */
export function repairHtmlFragment(fragment: string): string {
	let text = fragment.replace(LEADING_TAG_TAIL, "").replace(TRAILING_TAG_HEAD, "");
	text = text.trim();
	let prefix = "";
	let out = "";
	let cursor = 0;
	let seen = false;
	const stack: string[] = [];
	const has = (level: number): boolean => stack.some((tag) => TABLE_LEVEL[tag] === level);
	/** Pop table elements at or below `level` (deeper first). */
	const popTo = (level: number): void => {
		while (stack.length > 0 && (TABLE_LEVEL[stack.at(-1) ?? ""] ?? -1) >= level) stack.pop();
	};
	for (const match of text.matchAll(TAG)) {
		const index = match.index ?? 0;
		out += text.slice(cursor, index);
		cursor = index + match[0].length;
		const closing = match[1] === "/";
		const tag = (match[2] ?? "").toLowerCase();
		const level = TABLE_LEVEL[tag];
		if (level === undefined) {
			out += match[0];
			continue;
		}
		if (!closing) {
			if (level > 0 && !has(0)) {
				out += "<table>";
				stack.push("table");
			}
			if (level === 3) {
				popTo(3);
				if (!has(2)) {
					out += "<tr>";
					stack.push("tr");
				}
			} else if (level === 2) {
				popTo(2);
			} else if (level === 1) {
				popTo(1);
			}
			out += match[0];
			stack.push(tag);
			seen = true;
			continue;
		}
		const open = stack.findLastIndex((entry) => TABLE_LEVEL[entry] === level);
		if (open >= 0) {
			stack.length = open;
			out += match[0];
		} else if (!seen) {
			// The chunk began inside this element: open it and its ancestors.
			const opened = level === 0 ? ["table"] : level === 1 ? ["table", tag] : level === 2 ? ["table", "tr"] : ["table", "tr", tag];
			prefix = opened.map((name) => `<${name}>`).join("");
			stack.push(...opened.slice(0, -1));
			out += match[0];
		}
		seen = true;
	}
	out += text.slice(cursor);
	const closers = stack
		.toReversed()
		.map((tag) => `</${tag}>`)
		.join("");
	return `${prefix}${out}${closers}`;
}
