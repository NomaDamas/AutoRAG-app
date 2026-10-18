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
	"iwork",
	"odt",
	"odp",
	"odg",
	"epub",
	"hwp",
	"font",
	"rtf",
	"mail",
	"msg",
	"contact",
	"calendar",
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
assign("pptx", ["pptx", "pptm", "ppsx", "potx"]);
// OpenDocument packages. `.ods` stays with the spreadsheet viewer.
assign("odt", ["odt"]);
assign("odp", ["odp"]);
// A drawing has no text model; its package embeds the first page as a PNG.
assign("odg", ["odg"]);
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
assign("archive", ["zip", "jar", "war", "apk", "ipa", "vsix", "crx", "tar", "gz", "gzip", "tgz"]);
// Apple's iWork packages are ZIPs whose `preview.jpg` is the first page, sheet,
// or slide; the listing of their `Index/*.iwa` protobufs would say nothing.
assign("iwork", ["numbers", "pages", "key"]);
assign("epub", ["epub"]);
assign("hwp", ["hwp", "hwpx"]);
assign("font", ["ttf", "otf", "woff", "woff2", "eot"]);
assign("rtf", ["rtf"]);
assign("mail", ["eml", "emlx", "mbox"]);
// Outlook's OLE2 container has to be parsed whole; a cut prefix has no directory.
assign("msg", ["msg"]);
assign("contact", ["vcf", "vcard"]);
assign("calendar", ["ics", "ical", "ifb"]);

export function viewerForExtension(ext: string): ViewerKind {
	const key = ext.toLowerCase().replace(/^\./, "");
	return viewers[key] ?? "fallback";
}

export function claimedViewerExtensions(): readonly { readonly ext: string; readonly kind: ViewerKind }[] {
	return Object.entries(viewers).map(([ext, kind]) => ({ ext, kind }));
}

/**
 * What a viewer needs from the main process. `stream` viewers load the file
 * through the range-capable protocol (media, fonts, and PDF, which pdf.js
 * fetches page by page); `prefix` viewers render however much text arrives;
 * `whole` viewers parse the entire file; `decode` viewers get an image the OS
 * decoded for them (the raw file when it cannot); `sniff` reads enough to tell
 * text from binary.
 */
export type ByteNeed = "stream" | "prefix" | "whole" | "decode" | "sniff" | "extract";

export function byteNeed(kind: ViewerKind): ByteNeed {
	switch (kind) {
		case "video":
		case "audio":
		case "image":
		case "font":
		case "pdf":
			return "stream";
		case "markdown":
		case "html":
		case "text":
		case "rtf":
		case "mail":
		case "contact":
		case "calendar":
			return "prefix";
		case "tiff":
		case "docx":
		case "sheet":
		case "pptx":
		case "odt":
		case "odp":
		case "archive":
		case "epub":
		case "hwp":
		case "msg":
			return "whole";
		case "heic":
			return "decode";
		case "iwork":
		case "odg":
			return "extract";
		case "fallback":
			return "sniff";
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
	potx: "PowerPoint template",
	odt: "OpenDocument text",
	ods: "OpenDocument spreadsheet",
	odp: "OpenDocument presentation",
	odg: "OpenDocument drawing",
	md: "Markdown",
	txt: "Plain text",
	json: "JSON",
	zip: "ZIP archive",
	tar: "TAR archive",
	gz: "GZIP archive",
	tgz: "GZIP archive",
	numbers: "Numbers spreadsheet",
	pages: "Pages document",
	key: "Keynote presentation",
	epub: "EPUB book",
	hwp: "HWP document",
	eml: "Email message",
	emlx: "Apple Mail message",
	msg: "Outlook message",
	mbox: "Mailbox",
	vcf: "vCard contact",
	vcard: "vCard contact",
	ics: "iCalendar event",
	ical: "iCalendar event",
	ifb: "iCalendar free/busy",
	hwpx: "HWPX document",
	ttf: "TrueType font",
	otf: "OpenType font",
	woff: "Web font",
	woff2: "Web font",
	exe: "Windows EXE File",
	msi: "Windows Installer Package",
	dll: "Windows Dynamic Library",
	dmg: "Disk Image",
	iso: "Disc Image",
	pkg: "Installer Package",
	app: "Application",
	py: "Python Source",
	html: "HTML Document",
	htm: "HTML Document",
};

export function describeExtension(ext: string): string {
	const key = ext.toLowerCase().replace(/^\./, "");
	const known = LABELS[key];
	if (known !== undefined) return known;
	if (key === "") return "Document";
	return `${key.toUpperCase()} file`;
}
