import { assertNever } from "./assert";

export const VIEWER_KINDS = [
	"image",
	"tiff",
	"heic",
	"video",
	"audio",
	"pdf",
	"docx",
	"sheet",
	"pptx",
	"markdown",
	"html",
	"text",
	"archive",
	"epub",
	"hwpx",
	"font",
	"rtf",
	"fallback",
] as const;

export type ViewerKind = (typeof VIEWER_KINDS)[number];

const viewers: Record<string, ViewerKind> = {};

function assign(kind: ViewerKind, extensions: readonly string[]): void {
	for (const extension of extensions) viewers[extension] = kind;
}

assign("image", ["png", "jpg", "jpeg", "jfif", "pjpeg", "pjp", "gif", "webp", "bmp", "svg", "avif", "ico", "apng"]);
assign("tiff", ["tif", "tiff"]);
assign("heic", ["heic", "heif"]);
assign("video", ["mp4", "m4v", "webm", "ogv", "mov", "mkv", "avi", "mpeg", "mpg", "mpe", "3gp", "3gpp"]);
assign("audio", ["mp3", "wav", "wave", "m4a", "aac", "flac", "opus", "ogg", "oga", "aiff", "aif", "weba", "mid", "midi"]);
assign("pdf", ["pdf"]);
assign("docx", ["docx", "docm", "dotx"]);
assign("sheet", ["xlsx", "xlsm", "xlsb", "xls", "csv", "tsv", "ods"]);
assign("pptx", ["pptx", "pptm", "ppsx"]);
assign("markdown", ["md", "markdown", "mdx"]);
assign("html", ["html", "htm", "xhtml"]);
assign("text", [
	"txt", "text", "log", "json", "jsonc", "xml", "yaml", "yml", "css", "scss", "less",
	"js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py", "pyw", "go", "rs",
	"java", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "cs", "rb", "php", "sh", "bash",
	"zsh", "sql", "toml", "ini", "cfg", "conf", "env", "vue", "svelte", "astro", "lua",
	"pl", "swift", "kt", "kts", "scala", "dart", "r", "jl", "hs", "ex", "exs", "erl",
	"clj", "cljs", "vim", "cmake", "gradle", "properties", "graphql", "gql", "proto",
	"diff", "patch", "rst", "tex", "lock",
]);
assign("archive", ["zip", "jar", "war", "apk", "ipa", "vsix", "crx", "numbers", "pages", "key", "tar", "gz", "gzip", "tgz"]);
assign("epub", ["epub"]);
assign("hwpx", ["hwpx"]);
assign("font", ["ttf", "otf", "woff", "woff2", "eot"]);
assign("rtf", ["rtf"]);

export function viewerForExtension(ext: string): ViewerKind {
	const key = ext.toLowerCase().replace(/^\./, "");
	return viewers[key] ?? "fallback";
}

export function wantsBytes(kind: ViewerKind): boolean {
	switch (kind) {
		case "video":
		case "audio":
		case "image":
		case "font":
			return false;
		case "tiff":
		case "heic":
		case "pdf":
		case "docx":
		case "sheet":
		case "pptx":
		case "markdown":
		case "html":
		case "text":
		case "archive":
		case "epub":
		case "hwpx":
		case "rtf":
		case "fallback":
			return true;
		default:
			return assertNever(kind);
	}
}

const MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jfif: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	avif: "image/avif",
	ico: "image/x-icon",
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	ogv: "video/ogg",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	wave: "audio/wav",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	aiff: "audio/aiff",
	aif: "audio/aiff",
	pdf: "application/pdf",
	ttf: "font/ttf",
	otf: "font/otf",
	woff: "font/woff",
	woff2: "font/woff2",
};

export function mimeForExtension(ext: string): string {
	return MIME[ext.toLowerCase().replace(/^\./, "")] ?? "application/octet-stream";
}

const LABELS: Readonly<Record<string, string>> = {
	png: "PNG image",
	jpg: "JPEG image",
	jpeg: "JPEG image",
	gif: "GIF image",
	webp: "WebP image",
	svg: "SVG image",
	heic: "HEIC image",
	tif: "TIFF image",
	tiff: "TIFF image",
	mp4: "MPEG-4 movie",
	mov: "QuickTime movie",
	webm: "WebM movie",
	mp3: "MP3 audio",
	wav: "WAV audio",
	pdf: "PDF document",
	docx: "Word document",
	xlsx: "Excel spreadsheet",
	xls: "Excel spreadsheet",
	csv: "CSV document",
	pptx: "PowerPoint presentation",
	md: "Markdown",
	txt: "Plain text",
	json: "JSON",
	zip: "ZIP archive",
	epub: "EPUB book",
	hwpx: "HWPX document",
	ttf: "TrueType font",
	otf: "OpenType font",
	woff: "Web font",
	woff2: "Web font",
};

export function describeExtension(ext: string): string {
	const key = ext.toLowerCase().replace(/^\./, "");
	const known = LABELS[key];
	if (known !== undefined) return known;
	if (key === "") return "Document";
	return `${key.toUpperCase()} file`;
}
