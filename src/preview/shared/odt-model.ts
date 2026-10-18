/**
 * The `.odt` model: the document's blocks from `content.xml` and the styles
 * they use (`content.xml` automatic styles over `styles.xml` named ones).
 * XML parsing is injected (`ParseOdf`) so this module never touches a DOM
 * global; `odf-render.ts` draws the blocks.
 */
import { type BlockContext, MAX_BLOCKS, readBlocks, type OdfBlock } from "./odf-blocks";
import { childNamed, collectStyles, parsePart, readParts, type OdfStyle, type ParseOdf } from "./odf-xml";

export interface OdtDocument {
	readonly blocks: readonly OdfBlock[];
	/** Whether the body was cut at `MAX_BLOCKS`. */
	readonly truncated: boolean;
}

export function buildOdtDocument(bytes: Uint8Array, parseXml: ParseOdf): OdtDocument | null {
	const parts = readParts(bytes, (name) => name === "content.xml" || name === "styles.xml");
	if (parts === null) return null;
	const content = parsePart(parts, "content.xml", parseXml);
	if (content === null) return null;
	const body = childNamed(childNamed(content, "body"), "text");
	if (body === null) return null;
	const styles = new Map<string, OdfStyle>();
	collectStyles(parsePart(parts, "styles.xml", parseXml), styles);
	collectStyles(content, styles);
	const ctx: BlockContext = { styles, count: 0 };
	const blocks = readBlocks(body, ctx);
	return { blocks, truncated: ctx.count >= MAX_BLOCKS };
}

/** Every picture entry the document references, so the caller inflates only those. */
export function odtPictures(document: OdtDocument): readonly string[] {
	const out = new Set<string>();
	const walk = (blocks: readonly OdfBlock[]): void => {
		for (const block of blocks) {
			if (block.kind === "paragraph") for (const image of block.images) out.add(image.entry);
			else if (block.kind === "list") for (const item of block.items) walk(item);
			else for (const row of block.rows) for (const cell of row) walk(cell.blocks);
		}
	};
	walk(document.blocks);
	return [...out];
}
