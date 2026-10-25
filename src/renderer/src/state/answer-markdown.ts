/**
 * Minimal markdown rendering for AI Search answers and evidence chunks.
 *
 * The reference (`design_handoff_ai_finder_v6`, DESIGN.md §5 AnswerCard) renders
 * answer text as paragraphs whose inline segments are plain text, `**bold**`,
 * and `[n]` citation chips. Evidence chunk bodies additionally render headings,
 * list items, quotes, and fenced code blocks (README §1, `proto:flags`).
 *
 * Images: a markdown image (`![alt](ref)`), an inline-code span holding an
 * image path or URL, and a bare absolute image path in a sentence all parse as
 * `image` segments. `source` records the spelling so the renderer can keep the
 * sentence reading as written and show the picture beside it.
 */

import { viewerForExtension } from "../../../preview/shared/registry";
import { resolveRelative } from "../../../preview/shared/location";
import { webUrl } from "../../../shared/fs-contract";
import { pipeTable, pipeTableLength, type PipeTablePart } from "./excerpt-format";
import { basename, isAbsolutePath } from "./paths";

export type InlineSegment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "bold"; readonly text: string }
	| { readonly kind: "code"; readonly text: string }
	| { readonly kind: "citation"; readonly number: number }
	| {
			readonly kind: "image";
			/** The reference as written: a path, a relative link, or a URL. */
			readonly target: string;
			/** Alt text of a markdown image; "" for paths. */
			readonly alt: string;
			/** How the answer spelled it: `![alt](ref)`, `` `path` ``, or a bare path. */
			readonly source: "markdown" | "code" | "bare";
	  }
	| {
			readonly kind: "link";
			/** The normalized `http(s)` URL the link opens. */
			readonly url: string;
			/** What the link shows: its markdown label, or the URL as written. Never holds another link. */
			readonly children: readonly InlineSegment[];
	  };

/** Extensions that name an image file, decodable by Chromium or not. */
const IMAGE_EXTENSIONS = "png|jpe?g|jfif|gif|webp|bmp|svg|avif|ico|apng|heic|heif|tiff?";
const IMAGE_FILE = new RegExp(`\\.(?:${IMAGE_EXTENSIONS})$`, "iu");

/**
 * One inline token. Alternatives in order: markdown image (`<ref>` form, then
 * plain), bold, code, markdown link and `<url>` autolink (http(s) only, so
 * `[1](3쪽)`, `[x](./a.md)` and `[x](javascript:…)` keep their old reading),
 * citation, a bare absolute image path, and a bare http(s) URL. The bare path
 * must start a word (so the tail of a relative `사진/a.png` never reads as
 * `/a.png`), may not contain whitespace, and ends at the first image extension
 * not followed by more name characters, so Korean particles ("…/a.png에") and
 * a sentence-final period stay outside the path. A bare URL is the longest run
 * of ASCII URL characters (RFC 3986), so a Korean particle ("…/docs에서") ends
 * it too; `trimUrl` then drops sentence punctuation from its end.
 */
const INLINE = new RegExp(
	[
		String.raw`!\[([^\]]*)\]\(\s*<([^>]+)>\s*\)`,
		String.raw`!\[([^\]]*)\]\(\s*([^)\s]+(?:\s+[^)\s"]+)*?)(?:\s+"[^"]*")?\s*\)`,
		String.raw`\*\*([^*]+)\*\*`,
		"`([^`]+)`",
		String.raw`\[([^\[\]]+)\]\(\s*(?:<(https?:\/\/[^<>\s]+)>|(https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+))(?:\s+"[^"]*")?\s*\)`,
		String.raw`<(https?:\/\/[^<>\s]+)>`,
		String.raw`\[([1-9]\d*)\]`,
		String.raw`(?<![\p{L}\p{N}_/.:~\\-])((?:\/|[A-Za-z]:\\)[^\s"'<>()\[\]*` + "`" + String.raw`]*?\.(?:${IMAGE_EXTENSIONS}))(?!\.?[A-Za-z0-9])`,
		String.raw`(?<![A-Za-z0-9_])(https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()*+,;=%]+)`,
	].join("|"),
	"giu",
);

/** True when inline code holds an image reference rather than code. */
function isImageReference(text: string): boolean {
	const trimmed = text.trim();
	if (!IMAGE_FILE.test(trimmed.split(/[?#]/u)[0] ?? "")) return false;
	return webUrl(trimmed) !== null || isAbsolutePath(trimmed) || /^file:\/\//iu.test(trimmed);
}

/**
 * A bare URL without the sentence around it: trailing `. , ; : ! ? ' *` end
 * the sentence, not the URL, and so does a `)` with no `(` in the URL to close.
 */
function trimUrl(raw: string): string {
	let url = raw;
	for (;;) {
		const last = url.at(-1);
		const closesOuterParen = last === ")" && url.split(")").length > url.split("(").length;
		if (last === undefined || !(closesOuterParen || ".,;:!?'*".includes(last))) return url;
		url = url.slice(0, -1);
	}
}

/** A link label cannot hold another link: a URL written as its own label reads as plain text. */
function labelSegments(label: string): readonly InlineSegment[] {
	return parseInline(label).flatMap((segment) => (segment.kind === "link" ? segment.children : [segment]));
}

/** `**` around a link: the weight moves onto what the link shows. */
function embolden(segments: readonly InlineSegment[]): readonly InlineSegment[] {
	return segments.map((segment): InlineSegment => {
		if (segment.kind === "text") return { kind: "bold", text: segment.text };
		return segment.kind === "link" ? { ...segment, children: embolden(segment.children) } : segment;
	});
}

/** Split an inline string into text / bold / code / link / citation / image segments. */
export function parseInline(text: string): readonly InlineSegment[] {
	const segments: InlineSegment[] = [];
	let cursor = 0;
	for (const match of text.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > cursor) {
			segments.push({ kind: "text", text: text.slice(cursor, index) });
		}
		const [, angleAlt, angleRef, alt, ref, bold, code, label, labelAngleUrl, labelUrl, autolink, citation, bare, bareUrl] = match;
		let length = match[0].length;
		if (angleRef !== undefined) {
			segments.push({ kind: "image", target: angleRef.trim(), alt: angleAlt ?? "", source: "markdown" });
		} else if (ref !== undefined) {
			segments.push({ kind: "image", target: ref, alt: alt ?? "", source: "markdown" });
		} else if (bold !== undefined) {
			const inner = parseInline(bold);
			segments.push(...(inner.some((segment) => segment.kind === "link") ? embolden(inner) : [{ kind: "bold", text: bold } as const]));
		} else if (code !== undefined) {
			segments.push(isImageReference(code) ? { kind: "image", target: code.trim(), alt: "", source: "code" } : { kind: "code", text: code });
		} else if (label !== undefined) {
			const url = webUrl(labelAngleUrl ?? labelUrl ?? "");
			segments.push(url === null ? { kind: "text", text: match[0] } : { kind: "link", url, children: labelSegments(label) });
		} else if (autolink !== undefined) {
			const url = webUrl(autolink);
			segments.push(url === null ? { kind: "text", text: match[0] } : { kind: "link", url, children: [{ kind: "text", text: autolink }] });
		} else if (citation !== undefined) {
			segments.push({ kind: "citation", number: Number(citation) });
		} else if (bare !== undefined) {
			segments.push({ kind: "image", target: bare, alt: "", source: "bare" });
		} else if (bareUrl !== undefined) {
			const written = trimUrl(bareUrl);
			const url = webUrl(written);
			length = written.length;
			segments.push(url === null ? { kind: "text", text: written } : { kind: "link", url, children: [{ kind: "text", text: written }] });
		}
		cursor = index + length;
	}
	if (cursor < text.length) {
		segments.push({ kind: "text", text: text.slice(cursor) });
	}
	return segments.length === 0 ? [{ kind: "text", text }] : segments;
}

/** A line made only of markdown images (and spacing): it renders as figures alone, without an empty text row. */
export function isImageOnlyLine(segments: readonly InlineSegment[]): boolean {
	return (
		segments.some((segment) => segment.kind === "image") &&
		segments.every((segment) => (segment.kind === "image" && segment.source === "markdown") || (segment.kind === "text" && segment.text.trim() === ""))
	);
}

/** Where an image reference points, and whether `<img>` can draw it. */
export type ImageTarget =
	| {
			readonly kind: "local";
			readonly path: string;
			readonly name: string;
			/** False for formats Chromium cannot decode (HEIC, TIFF): show a card, not a broken image. */
			readonly renderable: boolean;
	  }
	| { readonly kind: "web"; readonly url: string }
	/** A relative link with no document folder to resolve it against. */
	| { readonly kind: "unresolved"; readonly text: string };

function decoded(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch (error) {
		if (error instanceof URIError) return text;
		throw error;
	}
}

/** `file:///C:/a%20b.png` -> `C:/a b.png`; `file:///Users/a.png` -> `/Users/a.png`. */
function pathFromFileUrl(reference: string): string | null {
	if (!/^file:\/\//iu.test(reference) || !URL.canParse(reference)) return null;
	const pathname = decoded(new URL(reference).pathname);
	return /^\/[A-Za-z]:\//u.test(pathname) ? pathname.slice(1).replaceAll("/", "\\") : pathname;
}

/**
 * Resolve an image reference. Absolute paths and `file:` URLs are local; a
 * relative link resolves against `folder` (the cited document's folder) when
 * there is one; http(s) is a web image, which the renderer never fetches.
 */
export function imageTarget(reference: string, folder: string | null): ImageTarget {
	const url = webUrl(reference);
	if (url !== null) return { kind: "web", url };
	const fromUrl = pathFromFileUrl(reference);
	const path =
		fromUrl ??
		(isAbsolutePath(reference)
			? decoded(reference)
			: folder === null || /^[a-z][a-z0-9+.-]*:/iu.test(reference)
				? null
				: resolveRelative(folder, reference));
	if (path === null) return { kind: "unresolved", text: reference };
	const name = basename(path);
	const ext = /\.([^.]+)$/u.exec(name)?.[1] ?? "";
	return { kind: "local", path, name, renderable: viewerForExtension(ext) === "image" };
}

/**
 * Distinct citation numbers referenced by answer or excerpt markdown, in
 * first-seen order. Used to tell which `[n]` chips the Evidence panel can
 * actually open.
 */
export function citedNumbers(markdown: string): readonly number[] {
	const numbers = new Set<number>();
	for (const match of markdown.matchAll(/\[([1-9]\d*)\]/gu)) {
		numbers.add(Number(match[1]));
	}
	return [...numbers];
}

/** Split a complete answer into display paragraphs on blank lines. */
export function splitAnswerParagraphs(answer: string): readonly string[] {
	return answer
		.split(/\n\s*\n/u)
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0);
}

export type AnswerBlockKind = "heading" | "list" | "quote" | "paragraph";

export type AnswerBlock =
	| { readonly kind: AnswerBlockKind; readonly text: string }
	/** A fenced code block; `language` is the first word of the fence's info string, lowercased. */
	| { readonly kind: "code"; readonly text: string; readonly language: string | null }
	/** A GFM pipe table; cells are inline markdown. */
	| { readonly kind: "table"; readonly header: PipeTablePart["header"]; readonly align: PipeTablePart["align"]; readonly rows: PipeTablePart["rows"] };

const HEADING = /^#{1,6}\s+/u;
const LIST = /^\s*(?:[-*•]|\d+[.)])\s+/u;
const QUOTE = /^>\s?/u;
const FENCE = /^```/u;

/** The language word of an opening fence line: ```` ```python title="a.py" ````, ```` ```{.ts} ````. */
function fenceLanguage(line: string): string | null {
	const word = line.slice(3).trim().split(/\s+/u)[0] ?? "";
	const name = word.replace(/^\{\.?/u, "").replace(/\}$/u, "").replace(/^\./u, "").toLowerCase();
	return name === "" ? null : name;
}

/**
 * Block-level markdown over an answer or an evidence excerpt. Contiguous plain
 * lines stay separate paragraphs: chunk excerpts use one line per sentence and
 * the reference renders each line as its own block.
 */
export function parseAnswerBlocks(markdown: string): readonly AnswerBlock[] {
	const blocks: AnswerBlock[] = [];
	const lines = markdown.split("\n");
	let inFence = false;
	let language: string | null = null;
	let fence: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const raw = lines[index] ?? "";
		if (!inFence && !FENCE.test(raw)) {
			const length = pipeTableLength(lines, index);
			if (length > 0) {
				const { header, align, rows } = pipeTable(lines.slice(index, index + length));
				blocks.push({ kind: "table", header, align, rows });
				index += length;
				continue;
			}
		}
		index += 1;
		if (FENCE.test(raw)) {
			if (inFence) {
				blocks.push({ kind: "code", text: fence.join("\n"), language });
				fence = [];
				inFence = false;
			} else {
				inFence = true;
				language = fenceLanguage(raw);
			}
			continue;
		}
		if (inFence) {
			fence.push(raw);
			continue;
		}
		const line = raw.trim();
		if (line.length === 0) {
			continue;
		}
		if (HEADING.test(line)) {
			blocks.push({ kind: "heading", text: line.replace(HEADING, "") });
		} else if (QUOTE.test(line)) {
			blocks.push({ kind: "quote", text: line.replace(QUOTE, "") });
		} else if (LIST.test(line)) {
			blocks.push({ kind: "list", text: line.replace(LIST, "") });
		} else {
			blocks.push({ kind: "paragraph", text: line });
		}
	}
	if (inFence) {
		blocks.push({ kind: "code", text: fence.join("\n").replace(/\n+$/u, ""), language });
	}
	return blocks;
}
