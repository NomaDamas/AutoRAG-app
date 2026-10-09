/**
 * The `.pptx`/`.pptm`/`.ppsx` model: presentation order, each slide's
 * background, and the shapes of every slide, read from the OOXML parts of the
 * package. XML parsing is injected (`ParseXml`) so this module never touches a
 * DOM global; `ui/pptx.tsx` supplies a `DOMParser`-backed parser and
 * `pptx-render.ts` draws the model. Images are referenced by zip entry name and
 * inflated by the caller, so a deck of any size is cheap to model.
 */
import { strFromU8, unzipSync } from "fflate";

/** English Metric Units per CSS pixel at 1:1; a slide's natural pixel size. */
export const EMU_PER_PX = 9525;
const XML_CAP = 8 * 1024 * 1024;
const DEFAULT_SLIDE_WIDTH = 12192000;
const DEFAULT_SLIDE_HEIGHT = 6858000;
const DEFAULT_INSET = { l: 91440, t: 45720, r: 91440, b: 45720 } as const;

/** The subset of `Document`/`Element` the model walks; the DOM satisfies it. */
export interface XmlElement {
	readonly localName: string;
	readonly childNodes: ArrayLike<XmlElement>;
	readonly textContent: string | null;
	getAttribute(name: string): string | null;
}

export interface XmlDocument {
	readonly documentElement: XmlElement | null;
}

export type ParseXml = (text: string) => XmlDocument | null;

export interface PptxTransform {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	/** Degrees clockwise. */
	readonly rot: number;
	readonly flipH: boolean;
	readonly flipV: boolean;
}

export type PptxFill = { readonly color: string } | null;
export interface PptxLine {
	readonly color: string;
	/** EMU. */
	readonly width: number;
}

export type PptxAlign = "l" | "ctr" | "r" | "just" | "dist";

export interface PptxRun {
	readonly text: string;
	/** Points. */
	readonly size: number;
	readonly bold: boolean;
	readonly italic: boolean;
	readonly underline: boolean;
	readonly color: string;
	readonly latin: string | null;
	readonly ea: string | null;
}

export interface PptxParagraph {
	readonly runs: readonly PptxRun[];
	readonly align: PptxAlign;
	readonly level: number;
	readonly bullet: string | null;
	/** EMU. */
	readonly indent: number;
	readonly spaceBefore: number;
	readonly spaceAfter: number;
}

export interface PptxText {
	readonly paragraphs: readonly PptxParagraph[];
	readonly anchor: "t" | "ctr" | "b";
	readonly inset: { readonly l: number; readonly t: number; readonly r: number; readonly b: number };
}

export type PptxGeometry = "rect" | "roundRect" | "ellipse";

export interface PptxTableCell {
	readonly text: PptxText | null;
	readonly fill: PptxFill;
	readonly gridSpan: number;
	readonly rowSpan: number;
}

export interface PptxTableRow {
	/** EMU. */
	readonly height: number;
	readonly cells: readonly PptxTableCell[];
}

export type PptxNode =
	| {
			readonly kind: "shape";
			readonly transform: PptxTransform;
			readonly geometry: PptxGeometry;
			readonly fill: PptxFill;
			readonly line: PptxLine | null;
			readonly text: PptxText | null;
	  }
	| {
			readonly kind: "picture";
			readonly transform: PptxTransform;
			readonly entry: string;
			readonly mime: string;
			/** Fractions of the source edge to crop away, 0..1. */
			readonly crop: { readonly l: number; readonly t: number; readonly r: number; readonly b: number };
	  }
	| {
			readonly kind: "group";
			readonly transform: PptxTransform;
			readonly childOffset: { readonly x: number; readonly y: number };
			readonly childExtent: { readonly w: number; readonly h: number };
			readonly children: readonly PptxNode[];
	  }
	| {
			readonly kind: "table";
			readonly transform: PptxTransform;
			/** EMU per column. */
			readonly columns: readonly number[];
			readonly rows: readonly PptxTableRow[];
	  }
	| { readonly kind: "placeholder"; readonly transform: PptxTransform; readonly label: string };

export interface PptxSlide {
	readonly background: string;
	readonly nodes: readonly PptxNode[];
	/** Zip entries the slide's pictures need, for the caller to inflate lazily. */
	readonly media: readonly string[];
	readonly error: string | null;
}

export interface PptxDeck {
	readonly width: number;
	readonly height: number;
	readonly slides: readonly PptxSlide[];
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

const PRESET_COLORS: Readonly<Record<string, string>> = {
	black: "#000000",
	white: "#FFFFFF",
	red: "#FF0000",
	green: "#008000",
	blue: "#0000FF",
	yellow: "#FFFF00",
	gray: "#808080",
	grey: "#808080",
	cyan: "#00FFFF",
	magenta: "#FF00FF",
};

/** The MIME type the renderer should give a picture entry, or `octet-stream`. */
export function entryMime(entry: string): string {
	const dot = entry.lastIndexOf(".");
	const ext = dot < 0 ? "" : entry.slice(dot + 1).toLowerCase();
	return IMAGE_MIME[ext] ?? "application/octet-stream";
}

function isImageEntry(entry: string): boolean {
	return entryMime(entry).startsWith("image/");
}

function isXmlPart(name: string): boolean {
	return (name.endsWith(".xml") || name.endsWith(".rels")) && (name.startsWith("ppt/") || name === "[Content_Types].xml");
}

function childNodesArray(element: XmlElement): readonly XmlElement[] {
	const out: XmlElement[] = [];
	for (let index = 0; index < element.childNodes.length; index += 1) {
		const child = element.childNodes[index];
		if (child !== undefined) out.push(child);
	}
	return out;
}

function childrenNamed(element: XmlElement | null, localName: string): readonly XmlElement[] {
	if (element === null) return [];
	return childNodesArray(element).filter((child) => child.localName === localName);
}

function childNamed(element: XmlElement | null, localName: string): XmlElement | null {
	if (element === null) return null;
	for (const child of childNodesArray(element)) {
		if (child.localName === localName) return child;
	}
	return null;
}

function attr(element: XmlElement | null, name: string): string | null {
	return element === null ? null : element.getAttribute(name);
}

function numberAttr(element: XmlElement | null, name: string): number | null {
	const raw = attr(element, name);
	if (raw === null) return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

function boolAttr(element: XmlElement | null, name: string): boolean | null {
	const raw = attr(element, name);
	if (raw === null) return null;
	return raw === "1" || raw === "true";
}

function toggleAttr(element: XmlElement | null, name: string): boolean {
	return boolAttr(element, name) === true;
}

function dirOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

function resolvePath(baseDir: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	const parts = (baseDir === "" ? [] : baseDir.split("/")).concat(target.split("/"));
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

function relsPathFor(partPath: string): string {
	const dir = dirOf(partPath);
	const base = dir === "" ? partPath : partPath.slice(dir.length + 1);
	return `${dir === "" ? "" : `${dir}/`}_rels/${base}.rels`;
}

interface Rel {
	readonly type: string;
	readonly target: string;
}

function relTarget(rels: ReadonlyMap<string, Rel>, type: string): string | null {
	for (const rel of rels.values()) {
		if (rel.type.endsWith(`/${type}`)) return rel.target;
	}
	return null;
}

function normalizeHex(raw: string | null): string | null {
	if (raw === null) return null;
	const value = raw.replace(/^#/, "").trim();
	if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) return null;
	return `#${value.slice(-6).toUpperCase()}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	return {
		r: parseInt(hex.slice(1, 3), 16) / 255,
		g: parseInt(hex.slice(3, 5), 16) / 255,
		b: parseInt(hex.slice(5, 7), 16) / 255,
	};
}

function rgbToHex(channel: number): string {
	const clamped = Math.max(0, Math.min(1, channel));
	return Math.round(clamped * 255)
		.toString(16)
		.padStart(2, "0")
		.toUpperCase();
}

function rgbToHsl(rgb: { r: number; g: number; b: number }): { h: number; s: number; l: number } {
	const max = Math.max(rgb.r, rgb.g, rgb.b);
	const min = Math.min(rgb.r, rgb.g, rgb.b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return { h: 0, s: 0, l };
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === rgb.r) h = (rgb.g - rgb.b) / d + (rgb.g < rgb.b ? 6 : 0);
	else if (max === rgb.g) h = (rgb.b - rgb.r) / d + 2;
	else h = (rgb.r - rgb.g) / d + 4;
	return { h: h / 6, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
	let value = t;
	if (value < 0) value += 1;
	if (value > 1) value -= 1;
	if (value < 1 / 6) return p + (q - p) * 6 * value;
	if (value < 1 / 2) return q;
	if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
	return p;
}

function hslToRgb(hsl: { h: number; s: number; l: number }): { r: number; g: number; b: number } {
	if (hsl.s === 0) return { r: hsl.l, g: hsl.l, b: hsl.l };
	const q = hsl.l < 0.5 ? hsl.l * (1 + hsl.s) : hsl.l + hsl.s - hsl.l * hsl.s;
	const p = 2 * hsl.l - q;
	return { r: hueToRgb(p, q, hsl.h + 1 / 3), g: hueToRgb(p, q, hsl.h), b: hueToRgb(p, q, hsl.h - 1 / 3) };
}

/** A percentage attribute such as lumMod's `50000` as a fraction. */
function percentAttr(element: XmlElement, name: string): number | null {
	const raw = numberAttr(element, name);
	return raw === null ? null : raw / 100000;
}

function applyColorTransforms(base: string, source: XmlElement): string {
	let hsl = rgbToHsl(hexToRgb(base));
	for (const child of childNodesArray(source)) {
		switch (child.localName) {
			case "lumMod": {
				const value = percentAttr(child, "val");
				if (value !== null) hsl = { ...hsl, l: hsl.l * value };
				break;
			}
			case "lumOff": {
				const value = percentAttr(child, "val");
				if (value !== null) hsl = { ...hsl, l: hsl.l + value };
				break;
			}
			case "satMod": {
				const value = percentAttr(child, "val");
				if (value !== null) hsl = { ...hsl, s: hsl.s * value };
				break;
			}
			case "tint": {
				const value = percentAttr(child, "val");
				if (value !== null) hsl = { ...hsl, l: hsl.l + (1 - hsl.l) * value };
				break;
			}
			case "shade": {
				const value = percentAttr(child, "val");
				if (value !== null) hsl = { ...hsl, l: hsl.l * (1 - value) };
				break;
			}
			default:
				break;
		}
	}
	const rgb = hslToRgb({ h: hsl.h, s: Math.max(0, Math.min(1, hsl.s)), l: Math.max(0, Math.min(1, hsl.l)) });
	return `#${rgbToHex(rgb.r)}${rgbToHex(rgb.g)}${rgbToHex(rgb.b)}`;
}

interface Theme {
	readonly colors: Readonly<Record<string, string>>;
	/** `+mj-lt` and friends to a real typeface. */
	readonly fonts: Readonly<Record<string, string>>;
}

const EMPTY_THEME: Theme = { colors: { tx1: "#000000", bg1: "#FFFFFF" }, fonts: {} };

function readThemeColorSlot(slot: XmlElement): string | null {
	return normalizeHex(attr(childNamed(slot, "srgbClr"), "val")) ?? normalizeHex(attr(childNamed(slot, "sysClr"), "lastClr"));
}

function parseTheme(root: XmlElement | null): Theme {
	const scheme = childNamed(childNamed(root, "themeElements"), "clrScheme");
	if (scheme === null) return EMPTY_THEME;
	const colors: Record<string, string> = {};
	for (const slot of childNodesArray(scheme)) {
		const value = readThemeColorSlot(slot);
		if (value !== null) colors[slot.localName] = value;
	}
	// `schemeClr` may name either a slot or its presentation alias.
	colors.tx1 = colors.tx1 ?? colors.dk1 ?? "#000000";
	colors.tx2 = colors.tx2 ?? colors.dk2 ?? colors.tx1;
	colors.bg1 = colors.bg1 ?? colors.lt1 ?? "#FFFFFF";
	colors.bg2 = colors.bg2 ?? colors.lt2 ?? colors.bg1;
	const fonts: Record<string, string> = {};
	const fontScheme = childNamed(childNamed(root, "themeElements"), "fontScheme");
	for (const [token, family] of [
		["+mj-lt", childNamed(childNamed(fontScheme, "majorFont"), "latin")],
		["+mj-ea", childNamed(childNamed(fontScheme, "majorFont"), "ea")],
		["+mn-lt", childNamed(childNamed(fontScheme, "minorFont"), "latin")],
		["+mn-ea", childNamed(childNamed(fontScheme, "minorFont"), "ea")],
	] as const) {
		const typeface = attr(family, "typeface");
		if (typeface !== null && typeface !== "") fonts[token] = typeface;
	}
	return { colors, fonts };
}

function schemeColor(element: XmlElement, theme: Theme): string {
	const name = attr(element, "val") ?? "";
	const base = theme.colors[name] ?? theme.colors[name === "phClr" ? "tx1" : ""] ?? "#000000";
	return applyColorTransforms(base, element);
}

/** A colour from an element that carries a colour child; null when it carries none. */
function readColor(element: XmlElement | null, theme: Theme): string | null {
	if (element === null) return null;
	const srgb = childNamed(element, "srgbClr");
	if (srgb !== null) return normalizeHex(attr(srgb, "val"));
	const scheme = childNamed(element, "schemeClr");
	if (scheme !== null) return schemeColor(scheme, theme);
	const sys = childNamed(element, "sysClr");
	if (sys !== null) return normalizeHex(attr(sys, "lastClr")) ?? "#000000";
	const preset = childNamed(element, "prstClr");
	if (preset !== null) return PRESET_COLORS[attr(preset, "val") ?? ""] ?? null;
	return null;
}

/**
 * The fill an element's `a:solidFill`/`a:noFill` describes: a colour, `null`
 * for no fill, or `undefined` when the element says nothing (inherit).
 */
function readFill(element: XmlElement | null, theme: Theme): PptxFill | undefined {
	if (element === null) return undefined;
	const solid = childNamed(element, "solidFill");
	if (solid !== null) return { color: readColor(solid, theme) ?? "#000000" };
	if (childNamed(element, "noFill") !== null) return null;
	return undefined;
}

function readLine(element: XmlElement | null, theme: Theme): PptxLine | null | undefined {
	const line = childNamed(element, "ln");
	if (line === null) return undefined;
	if (childNamed(line, "noFill") !== null) return null;
	const solid = childNamed(line, "solidFill");
	if (solid === null) return null;
	return { color: readColor(solid, theme) ?? "#000000", width: numberAttr(line, "w") ?? 12700 };
}

function readXfrm(element: XmlElement | null): PptxTransform | null {
	if (element === null) return null;
	const off = childNamed(element, "off");
	const ext = childNamed(element, "ext");
	if (off === null || ext === null) return null;
	return {
		x: numberAttr(off, "x") ?? 0,
		y: numberAttr(off, "y") ?? 0,
		w: numberAttr(ext, "cx") ?? 0,
		h: numberAttr(ext, "cy") ?? 0,
		rot: (numberAttr(element, "rot") ?? 0) / 60000,
		flipH: toggleAttr(element, "flipH"),
		flipV: toggleAttr(element, "flipV"),
	};
}

// --- text -------------------------------------------------------------------

interface LevelStyle {
	readonly size: number | null;
	readonly bold: boolean | null;
	readonly italic: boolean | null;
	readonly underline: boolean | null;
	readonly color: string | null;
	readonly latin: string | null;
	readonly ea: string | null;
	readonly align: string | null;
	readonly bullet: string | null;
	readonly bulletKnown: boolean;
	readonly indent: number | null;
}

const EMPTY_LEVEL: LevelStyle = {
	size: null,
	bold: null,
	italic: null,
	underline: null,
	color: null,
	latin: null,
	ea: null,
	align: null,
	bullet: null,
	bulletKnown: false,
	indent: null,
};

interface RunProps {
	readonly size: number | null;
	readonly bold: boolean | null;
	readonly italic: boolean | null;
	readonly underline: boolean | null;
	readonly color: string | null;
	readonly latin: string | null;
	readonly ea: string | null;
}

const EMPTY_RUN: RunProps = { size: null, bold: null, italic: null, underline: null, color: null, latin: null, ea: null };

/** `u` is a style name (`sng`, `dbl`, …) rather than a boolean; anything but `none` is underlined. */
function readUnderline(element: XmlElement): boolean | null {
	const raw = attr(element, "u");
	return raw === null ? null : raw !== "none";
}

function readRunProps(element: XmlElement | null, theme: Theme): RunProps {
	if (element === null) return EMPTY_RUN;
	const size = numberAttr(element, "sz");
	return {
		size: size === null ? null : size / 100,
		bold: boolAttr(element, "b"),
		italic: boolAttr(element, "i"),
		underline: readUnderline(element),
		color: readColor(element, theme),
		latin: attr(childNamed(element, "latin"), "typeface"),
		ea: attr(childNamed(element, "ea"), "typeface"),
	};
}

function readBullet(pPr: XmlElement): { bullet: string | null; known: boolean } {
	if (childNamed(pPr, "buNone") !== null) return { bullet: null, known: true };
	const char = childNamed(pPr, "buChar");
	if (char !== null) return { bullet: attr(char, "char") ?? "•", known: true };
	if (childNamed(pPr, "buAutoNum") !== null) return { bullet: "•", known: true };
	return { bullet: null, known: false };
}

function readLevel(pPr: XmlElement, theme: Theme): LevelStyle {
	const props = readRunProps(childNamed(pPr, "defRPr"), theme);
	const bullet = readBullet(pPr);
	return {
		size: props.size,
		bold: props.bold,
		italic: props.italic,
		underline: props.underline,
		color: props.color,
		latin: props.latin,
		ea: props.ea,
		align: attr(pPr, "algn"),
		bullet: bullet.bullet,
		bulletKnown: bullet.known,
		indent: numberAttr(pPr, "marL"),
	};
}

function levelsFrom(lstStyle: XmlElement | null, theme: Theme): readonly LevelStyle[] {
	const out: LevelStyle[] = [];
	for (let index = 0; index < 9; index += 1) {
		const pPr = childNamed(lstStyle, `lvl${index + 1}pPr`);
		out.push(pPr === null ? EMPTY_LEVEL : readLevel(pPr, theme));
	}
	return out;
}

function mergeLevels(sources: readonly (readonly LevelStyle[])[]): readonly LevelStyle[] {
	const out: LevelStyle[] = [];
	for (let index = 0; index < 9; index += 1) {
		let merged = EMPTY_LEVEL;
		for (const source of sources) {
			const level = source[index] ?? EMPTY_LEVEL;
			merged = {
				size: level.size ?? merged.size,
				bold: level.bold ?? merged.bold,
				italic: level.italic ?? merged.italic,
				underline: level.underline ?? merged.underline,
				color: level.color ?? merged.color,
				latin: level.latin ?? merged.latin,
				ea: level.ea ?? merged.ea,
				align: level.align ?? merged.align,
				bullet: level.bulletKnown ? level.bullet : merged.bullet,
				bulletKnown: level.bulletKnown || merged.bulletKnown,
				indent: level.indent ?? merged.indent,
			};
		}
		out.push(merged);
	}
	return out;
}

function mergeRunProps(...sources: readonly RunProps[]): RunProps {
	let merged = EMPTY_RUN;
	for (const source of sources) {
		merged = {
			size: source.size ?? merged.size,
			bold: source.bold ?? merged.bold,
			italic: source.italic ?? merged.italic,
			underline: source.underline ?? merged.underline,
			color: source.color ?? merged.color,
			latin: source.latin ?? merged.latin,
			ea: source.ea ?? merged.ea,
		};
	}
	return merged;
}

function resolveTypeface(value: string | null, theme: Theme): string | null {
	if (value === null || value === "") return null;
	return value.startsWith("+") ? theme.fonts[value] ?? null : value;
}

function readAlign(raw: string | null): PptxAlign {
	switch (raw) {
		case "ctr":
		case "r":
		case "just":
		case "dist":
			return raw;
		default:
			return "l";
	}
}

function resolveRun(level: LevelStyle, defRPr: XmlElement | null, rPr: XmlElement | null, theme: Theme): RunProps {
	return mergeRunProps(
		{ size: level.size, bold: level.bold, italic: level.italic, underline: level.underline, color: level.color, latin: level.latin, ea: level.ea },
		readRunProps(defRPr, theme),
		readRunProps(rPr, theme),
	);
}

function readText(txBody: XmlElement | null, levels: readonly LevelStyle[], theme: Theme): PptxText | null {
	if (txBody === null) return null;
	const bodyPr = childNamed(txBody, "bodyPr");
	const paragraphs: PptxParagraph[] = [];
	for (const p of childrenNamed(txBody, "p")) {
		const pPr = childNamed(p, "pPr");
		const level = Math.min(8, Math.max(0, Math.round(numberAttr(pPr, "lvl") ?? 0)));
		const style = levels[level] ?? EMPTY_LEVEL;
		const defRPr = childNamed(pPr, "defRPr");
		const runs: PptxRun[] = [];
		for (const item of childNodesArray(p)) {
			if (item.localName === "br") {
				const props = resolveRun(style, defRPr, null, theme);
				runs.push(resolvedRun("\n", props, theme, style));
			} else if (item.localName === "r" || item.localName === "fld") {
				const text = childNamed(item, "t")?.textContent ?? "";
				if (text === "") continue;
				const props = resolveRun(style, defRPr, childNamed(item, "rPr"), theme);
				runs.push(resolvedRun(text, props, theme, style));
			}
		}
		if (runs.length === 0) continue;
		paragraphs.push({
			runs,
			align: readAlign(attr(pPr, "algn") ?? style.align),
			level,
			bullet: style.bulletKnown ? style.bullet : null,
			indent: numberAttr(pPr, "marL") ?? style.indent ?? 0,
			spaceBefore: readSpacing(childNamed(pPr, "spcBef")),
			spaceAfter: readSpacing(childNamed(pPr, "spcAft")),
		});
	}
	const anchorRaw = attr(bodyPr, "anchor");
	const anchor: PptxText["anchor"] = anchorRaw === "ctr" ? "ctr" : anchorRaw === "b" ? "b" : "t";
	return {
		paragraphs,
		anchor,
		inset: {
			l: numberAttr(bodyPr, "lIns") ?? DEFAULT_INSET.l,
			t: numberAttr(bodyPr, "tIns") ?? DEFAULT_INSET.t,
			r: numberAttr(bodyPr, "rIns") ?? DEFAULT_INSET.r,
			b: numberAttr(bodyPr, "bIns") ?? DEFAULT_INSET.b,
		},
	};
}

function resolvedRun(text: string, props: RunProps, theme: Theme, level: LevelStyle): PptxRun {
	return {
		text,
		size: props.size ?? 18,
		bold: props.bold ?? false,
		italic: props.italic ?? false,
		underline: props.underline ?? false,
		color: props.color ?? theme.colors.tx1 ?? "#000000",
		latin: resolveTypeface(props.latin ?? level.latin, theme),
		ea: resolveTypeface(props.ea ?? level.ea, theme),
	};
}

/** `a:spcBef`/`a:spcAft` in EMU; 0 for percentage spacing or nothing. */
function readSpacing(spacing: XmlElement | null): number {
	const points = numberAttr(childNamed(spacing, "spcPts"), "val");
	return points === null ? 0 : Math.round((points / 100) * 12700);
}

// --- shapes ------------------------------------------------------------------

interface TxStyles {
	readonly title: readonly LevelStyle[];
	readonly body: readonly LevelStyle[];
	readonly other: readonly LevelStyle[];
}

function readTxStyles(master: XmlElement | null, theme: Theme): TxStyles {
	const styles = childNamed(master, "txStyles");
	return {
		title: levelsFrom(childNamed(childNamed(styles, "titleStyle"), "lstStyle"), theme),
		body: levelsFrom(childNamed(childNamed(styles, "bodyStyle"), "lstStyle"), theme),
		other: levelsFrom(childNamed(childNamed(styles, "otherStyle"), "lstStyle"), theme),
	};
}

function levelsFor(styles: TxStyles, phType: string): readonly LevelStyle[] {
	if (phType === "title" || phType === "ctrTitle") return styles.title;
	if (phType === "body" || phType === "obj" || phType === "subTitle") return styles.body;
	return styles.other;
}

function placeholderOf(shape: XmlElement): XmlElement | null {
	return childNamed(childNamed(childNamed(shape, "nvSpPr"), "nvPr"), "ph");
}

function findPlaceholder(root: XmlElement | null, phType: string, phIdx: string | null): XmlElement | null {
	const spTree = childNamed(childNamed(root, "cSld"), "spTree");
	for (const shape of childrenNamed(spTree, "sp")) {
		const ph = placeholderOf(shape);
		if (ph === null) continue;
		const idx = attr(ph, "idx");
		if (phIdx !== null) {
			if (idx === phIdx) return shape;
		} else if ((attr(ph, "type") ?? "obj") === phType) {
			return shape;
		}
	}
	return null;
}

interface PlaceholderDefaults {
	readonly transform: PptxTransform | null;
	readonly fill: PptxFill;
	readonly line: PptxLine | null;
	readonly levels: readonly LevelStyle[];
	readonly type: string;
}

interface NodeContext {
	readonly rels: ReadonlyMap<string, Rel>;
	readonly layout: XmlElement | null;
	readonly master: XmlElement | null;
	readonly theme: Theme;
	readonly txStyles: TxStyles;
	readonly slideDir: string;
}

function placeholderDefaults(ph: XmlElement, ctx: NodeContext): PlaceholderDefaults {
	const type = attr(ph, "type") ?? "obj";
	const idx = attr(ph, "idx");
	const lower = findPlaceholder(ctx.layout, type, idx);
	const upper = findPlaceholder(ctx.master, type, idx);
	const lowerSpPr = childNamed(lower, "spPr");
	const upperSpPr = childNamed(upper, "spPr");
	return {
		transform: readXfrm(childNamed(lowerSpPr, "xfrm")) ?? readXfrm(childNamed(upperSpPr, "xfrm")),
		fill: readFill(lowerSpPr, ctx.theme) ?? readFill(upperSpPr, ctx.theme) ?? null,
		line: readLine(lowerSpPr, ctx.theme) ?? readLine(upperSpPr, ctx.theme) ?? null,
		levels: mergeLevels([
			levelsFrom(childNamed(childNamed(upper, "txBody"), "lstStyle"), ctx.theme),
			levelsFrom(childNamed(childNamed(lower, "txBody"), "lstStyle"), ctx.theme),
		]),
		type,
	};
}

function readGeometry(prstGeom: XmlElement | null): PptxGeometry {
	switch (attr(prstGeom, "prst")) {
		case "ellipse":
		case "circle":
			return "ellipse";
		case "roundRect":
		case "round1Rect":
		case "round2SameRect":
		case "round2DiagRect":
			return "roundRect";
		default:
			return "rect";
	}
}

function buildShape(shape: XmlElement, ctx: NodeContext): PptxNode | null {
	const ph = placeholderOf(shape);
	const defaults = ph === null ? null : placeholderDefaults(ph, ctx);
	const spPr = childNamed(shape, "spPr");
	const transform = readXfrm(childNamed(spPr, "xfrm")) ?? defaults?.transform ?? null;
	if (transform === null) return null;
	const txBody = childNamed(shape, "txBody");
	const baseLevels = levelsFor(ctx.txStyles, defaults?.type ?? "obj");
	const levels = mergeLevels([baseLevels, defaults?.levels ?? [], levelsFrom(childNamed(txBody, "lstStyle"), ctx.theme)]);
	const ownFill = readFill(spPr, ctx.theme);
	const ownLine = readLine(spPr, ctx.theme);
	return {
		kind: "shape",
		transform,
		geometry: readGeometry(childNamed(spPr, "prstGeom")),
		fill: ownFill !== undefined ? ownFill : defaults?.fill ?? null,
		line: ownLine !== undefined ? ownLine : defaults?.line ?? null,
		text: readText(txBody, levels, ctx.theme),
	};
}

function buildPicture(picture: XmlElement, ctx: NodeContext): PptxNode | null {
	const ph = placeholderOf(picture);
	const defaults = ph === null ? null : placeholderDefaults(ph, ctx);
	const transform = readXfrm(childNamed(childNamed(picture, "spPr"), "xfrm")) ?? defaults?.transform ?? null;
	if (transform === null) return null;
	const blipFill = childNamed(picture, "blipFill");
	const embed = attr(childNamed(blipFill, "blip"), "r:embed");
	const rel = embed === null ? undefined : ctx.rels.get(embed);
	const entry = rel === undefined ? null : resolvePath(ctx.slideDir, rel.target);
	if (entry === null || !isImageEntry(entry)) {
		return { kind: "placeholder", transform, label: "이미지" };
	}
	const srcRect = childNamed(blipFill, "srcRect");
	const crop = {
		l: (numberAttr(srcRect, "l") ?? 0) / 100000,
		t: (numberAttr(srcRect, "t") ?? 0) / 100000,
		r: (numberAttr(srcRect, "r") ?? 0) / 100000,
		b: (numberAttr(srcRect, "b") ?? 0) / 100000,
	};
	return { kind: "picture", transform, entry, mime: entryMime(entry), crop };
}

function buildGroup(group: XmlElement, ctx: NodeContext): PptxNode | null {
	const grpSpPr = childNamed(group, "grpSpPr");
	const xfrm = childNamed(grpSpPr, "xfrm");
	const transform = readXfrm(xfrm);
	if (transform === null) return null;
	const chOff = childNamed(xfrm, "chOff");
	const chExt = childNamed(xfrm, "chExt");
	const children: PptxNode[] = [];
	for (const item of childNodesArray(group)) {
		if (item.localName === "nvGrpSpPr" || item.localName === "grpSpPr") continue;
		const node = buildNode(item, ctx);
		if (node !== null) children.push(node);
	}
	return {
		kind: "group",
		transform,
		childOffset: { x: numberAttr(chOff, "x") ?? 0, y: numberAttr(chOff, "y") ?? 0 },
		childExtent: { w: numberAttr(chExt, "cx") ?? transform.w, h: numberAttr(chExt, "cy") ?? transform.h },
		children,
	};
}

function graphicLabel(uri: string): string {
	if (uri.includes("/chart")) return "차트";
	if (uri.includes("/diagram")) return "SmartArt";
	if (uri.includes("/media")) return "미디어";
	return "개체";
}

function buildTable(table: XmlElement, transform: PptxTransform, ctx: NodeContext): PptxNode {
	const columns = childrenNamed(childNamed(table, "tblGrid"), "gridCol").map((column) => numberAttr(column, "w") ?? 0);
	const levels = levelsFor(ctx.txStyles, "other");
	const rows: PptxTableRow[] = childrenNamed(table, "tr").map((row) => ({
		height: numberAttr(row, "h") ?? 0,
		cells: childrenNamed(row, "tc").map((cell) => {
			const fill = readFill(childNamed(cell, "tcPr"), ctx.theme);
			return {
				text: readText(childNamed(cell, "txBody"), levels, ctx.theme),
				fill: fill === undefined ? null : fill,
				gridSpan: numberAttr(cell, "gridSpan") ?? 1,
				rowSpan: numberAttr(cell, "rowSpan") ?? 1,
			};
		}),
	}));
	return { kind: "table", transform, columns, rows };
}

function buildGraphicFrame(frame: XmlElement, ctx: NodeContext): PptxNode | null {
	const transform = readXfrm(childNamed(frame, "xfrm"));
	if (transform === null) return null;
	const graphicData = childNamed(childNamed(frame, "graphic"), "graphicData");
	const table = childNamed(graphicData, "tbl");
	if (table !== null) return buildTable(table, transform, ctx);
	return { kind: "placeholder", transform, label: graphicLabel(attr(graphicData, "uri") ?? "") };
}

function buildNode(shape: XmlElement, ctx: NodeContext): PptxNode | null {
	switch (shape.localName) {
		case "sp":
		case "cxnSp":
			return buildShape(shape, ctx);
		case "pic":
			return buildPicture(shape, ctx);
		case "grpSp":
			return buildGroup(shape, ctx);
		case "graphicFrame":
			return buildGraphicFrame(shape, ctx);
		case "contentPart":
			return {
				kind: "placeholder",
				transform: readXfrm(childNamed(childNamed(shape, "spPr"), "xfrm")) ?? { x: 0, y: 0, w: 0, h: 0, rot: 0, flipH: false, flipV: false },
				label: "미디어",
			};
		default:
			return null;
	}
}

function collectMedia(nodes: readonly PptxNode[]): readonly string[] {
	const entries = new Set<string>();
	const walk = (node: PptxNode): void => {
		if (node.kind === "picture") entries.add(node.entry);
		else if (node.kind === "group") for (const child of node.children) walk(child);
	};
	for (const node of nodes) walk(node);
	return [...entries];
}

function readBackground(cSld: XmlElement | null, layout: XmlElement | null, master: XmlElement | null, theme: Theme): string {
	for (const holder of [cSld, childNamed(layout, "cSld"), childNamed(master, "cSld")]) {
		const bg = childNamed(holder, "bg");
		if (bg === null) continue;
		const bgPr = childNamed(bg, "bgPr");
		if (bgPr !== null) {
			const solid = childNamed(bgPr, "solidFill");
			if (solid !== null) return readColor(solid, theme) ?? "#FFFFFF";
			if (childNamed(bgPr, "noFill") !== null) return "#FFFFFF";
			continue;
		}
		const bgRef = childNamed(bg, "bgRef");
		if (bgRef !== null) {
			const scheme = childNamed(bgRef, "schemeClr");
			if (scheme !== null) return schemeColor(scheme, theme) ?? "#FFFFFF";
		}
	}
	return "#FFFFFF";
}

function slideSize(root: XmlElement): { readonly cx: number; readonly cy: number } {
	const size = childNamed(root, "sldSz");
	return { cx: numberAttr(size, "cx") ?? DEFAULT_SLIDE_WIDTH, cy: numberAttr(size, "cy") ?? DEFAULT_SLIDE_HEIGHT };
}

interface BuildContext {
	part(name: string): XmlElement | null;
}

function readRels(root: XmlElement | null): Map<string, Rel> {
	const rels = new Map<string, Rel>();
	for (const rel of childrenNamed(root, "Relationship")) {
		const id = attr(rel, "Id");
		const type = attr(rel, "Type");
		const target = attr(rel, "Target");
		if (id !== null && type !== null && target !== null) rels.set(id, { type, target });
	}
	return rels;
}

function buildSlide(path: string, ctx: BuildContext): PptxSlide {
	const empty: PptxSlide = { background: "#FFFFFF", nodes: [], media: [], error: null };
	const slide = ctx.part(path);
	if (slide === null || slide.localName !== "sld") return { ...empty, error: "슬라이드를 읽지 못했습니다" };
	try {
		const rels = readRels(ctx.part(relsPathFor(path)));
		// A relationship target is relative to the part that declares it, so each
		// part path is resolved before its own `.rels` is read.
		const layoutTarget = relTarget(rels, "slideLayout");
		const layoutPath = layoutTarget === null ? null : resolvePath(dirOf(path), layoutTarget);
		const layout = layoutPath === null ? null : ctx.part(layoutPath);
		const masterTarget = layoutPath === null ? null : relTarget(readRels(ctx.part(relsPathFor(layoutPath))), "slideMaster");
		const masterPath = masterTarget === null ? null : resolvePath(dirOf(layoutPath ?? ""), masterTarget);
		const master = masterPath === null ? null : ctx.part(masterPath);
		const themeTarget = masterPath === null ? null : relTarget(readRels(ctx.part(relsPathFor(masterPath))), "theme");
		const themePath = themeTarget === null ? null : resolvePath(dirOf(masterPath ?? ""), themeTarget);
		const theme = parseTheme(themePath === null ? null : ctx.part(themePath));
		const cSld = childNamed(slide, "cSld");
		const spTree = childNamed(cSld, "spTree");
		const nodeCtx: NodeContext = {
			rels,
			layout,
			master,
			theme,
			txStyles: readTxStyles(master, theme),
			slideDir: dirOf(path),
		};
		const nodes: PptxNode[] = [];
		// Walk every child of the shape tree in document order (z-order), skipping the group bookkeeping.
		for (const shape of spTree === null ? [] : childNodesArray(spTree)) {
			if (shape.localName === "nvGrpSpPr" || shape.localName === "grpSpPr") continue;
			const node = buildNode(shape, nodeCtx);
			if (node !== null) nodes.push(node);
		}
		return { background: readBackground(cSld, layout, master, theme), nodes, media: collectMedia(nodes), error: null };
	} catch {
		return { ...empty, error: "슬라이드를 표시할 수 없습니다" };
	}
}

/** Reads a presentation's XML parts and models its slides; null when nothing parses. */
export function buildPptxDeck(bytes: Uint8Array, parseXml: ParseXml): PptxDeck | null {
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(bytes, {
			filter: (entry) => isXmlPart(entry.name) && entry.originalSize <= XML_CAP && (entry.compression === 0 || entry.compression === 8),
		});
	} catch {
		return null;
	}
	const texts = new Map<string, string>();
	for (const [name, data] of Object.entries(entries)) {
		try {
			texts.set(name, strFromU8(data));
		} catch {
			// A part that is not UTF-8 cannot be OOXML we can read.
		}
	}
	const cache = new Map<string, XmlElement | null>();
	const ctx: BuildContext = {
		part(name) {
			if (!cache.has(name)) {
				const text = texts.get(name);
				let root: XmlElement | null = null;
				if (text !== undefined) {
					try {
						root = parseXml(text)?.documentElement ?? null;
					} catch {
						root = null;
					}
				}
				cache.set(name, root);
			}
			return cache.get(name) ?? null;
		},
	};
	const presentation = ctx.part("ppt/presentation.xml");
	if (presentation === null) return null;
	const size = slideSize(presentation);
	const rels = readRels(ctx.part("ppt/_rels/presentation.xml.rels"));
	const slides: string[] = [];
	for (const sldId of childrenNamed(childNamed(presentation, "sldIdLst"), "sldId")) {
		const relId = attr(sldId, "r:id");
		const rel = relId === null ? undefined : rels.get(relId);
		if (rel !== undefined) slides.push(resolvePath("ppt", rel.target));
	}
	if (slides.length === 0) return null;
	return { width: size.cx, height: size.cy, slides: slides.map((path) => buildSlide(path, ctx)) };
}
