import type { AppSettings } from "../../shared/settings-contract";
import type { BinaryKind } from "./binary-kind";
import type { ArchiveEntry } from "./archive-items";
import type { KeyUsageName } from "./certificate";
import type { Bounds, QuickLookFit } from "./fit";
import type { ZoomDirection, ZoomGeometry } from "./zoom";

/**
 * Quick Look runs in its own pre-warmed BrowserWindow (the sigma-file-manager
 * v1 design). The Finder window asks the main process to show or hide a file;
 * the main process reads the file once and pushes it to the preview window,
 * which reports the media size back so the window can fit it before it shows.
 */
export const PREVIEW_CHANNELS = {
	/** Finder -> main (invoke): preview this file. */
	show: "preview:show",
	/** Finder -> main (invoke): hide the preview. */
	hide: "preview:hide",
	/** Finder -> main (send): this file is selected; start rendering it so Space finds it ready. */
	prefetch: "preview:prefetch",
	/** Main -> Finder: the preview closed itself (Space, Escape, close button). */
	closed: "preview:closed",
	/** Main -> Finder: move the Finder selection (arrow keys pressed in the preview). */
	navigate: "preview:navigate",
	/** Main -> preview window: render this file. */
	load: "preview:load",
	/** Main -> preview window: drop the content so media stops. */
	unload: "preview:unload",
	/** Preview window -> main: the file rendered; media size when it has one. */
	ready: "preview:ready",
	/** Preview window -> main (invoke): toolbar and keyboard actions. */
	request: "preview:request",
	/** Main -> preview window: drive one step of the open/close zoom. */
	zoom: "preview:zoom",
	/** Preview window -> main: a zoom step finished. */
	zoomed: "preview:zoomed",
	/** Main -> preview window: the default app that "Open with" launches, once known. */
	app: "preview:app",
	/** Main -> preview window: the Office page macOS drew landed (first-page image, then the whole page). */
	office: "preview:office",
	/** Main -> preview window: Keynote finished drawing a deck's slides at full size (or could not). */
	slides: "preview:slides",
	/** Main -> preview window: a native document's OS thumbnail finished after the panel opened. */
	thumbnail: "preview:thumbnail",
	/** Preview window -> main (invoke): creation date, location, and binary kind of the shown file. */
	details: "preview:details",
	/** Preview window -> main (invoke): SHA-256 of the shown file. */
	sha256: "preview:sha256",
	/** Preview window -> main (invoke): total size below the shown folder. */
	folderSize: "preview:folder-size",
	/** Preview window -> main (invoke): tags, cover art, and stream facts of the shown audio file. */
	audioMetadata: "preview:audio-metadata",
	/** Preview window -> main (invoke): tables and first rows of the shown database or Parquet file. */
	data: "preview:data",
	/** Preview window -> main (invoke): the top-level children of the shown 7z, RAR, ISO, deb, rpm, CAB, or tar.bz2/xz/zst. */
	archive: "preview:archive",
	/** Preview window -> main (invoke): the subject, validity, and fingerprints of the shown certificate file, or what kind of container it is. */
	certificate: "preview:certificate",
	/** Preview window -> main (invoke): the macOS share menu, anchored under a toolbar rect. */
	share: "preview:share",
	/** Preview window -> main (invoke): put text on the system clipboard. */
	copyText: "preview:copy-text",
	/** Preview window -> main (send): a text field took or gave up focus; Space and the arrows stay with it while it has focus. */
	textEntry: "preview:text-entry",
} as const;

/** Structured content decoded from an Apple pointer, archive, clipping, or directory package. */
export type NativePreview =
	| { readonly kind: "webloc"; readonly title: string; readonly url: string }
	| { readonly kind: "webarchive"; readonly html: string }
	| { readonly kind: "rtfd"; readonly rtf: Uint8Array; readonly attachments: readonly string[] }
	| { readonly kind: "iconset"; readonly icons: readonly { readonly name: string; readonly bytes: Uint8Array }[] }
	| { readonly kind: "textclipping"; readonly text: string };

/**
 * One file the preview can render. `bytes` is null when the viewer streams
 * the custom protocol instead, or when the file is over the byte cap.
 */
export interface PreviewDocument {
	readonly name: string;
	readonly path: string;
	readonly ext: string;
	readonly size: number;
	readonly modifiedAt: string;
	readonly mime: string;
	readonly truncated: boolean;
	readonly bytes: Uint8Array | null;
	/**
	 * Every slide/page JPEG in order for a Keynote deck (the quality first-page
	 * image first); null for every other document, whose viewer uses `bytes`.
	 */
	readonly pages: readonly Uint8Array[] | null;
	/** What macOS draws for a legacy Office file; null for every other document. */
	readonly office: OfficePage | null;
	/**
	 * `autorag-thumb://` URL of the picture the OS drew for a Google Drive
	 * pointer file (`.gdoc`, ...); null for every other document.
	 */
	readonly thumbnail: string | null;
	/** Decoded native content; absent for every ordinary document. */
	readonly native?: NativePreview | null;
	/** Directory packages have no single-file byte size to display. */
	readonly package?: boolean;
	/**
	 * True while Keynote is drawing a deck's slides at full size; `pages` then
	 * still holds the package's 356px renders. False for every other document.
	 */
	readonly slidesRendering: boolean;
}

/**
 * What macOS's own Office generator has drawn for a legacy Office file so far.
 * The first-page image (the OS thumbnail, ready in tens of milliseconds) lets
 * the panel appear at once; `html` is the whole document as one self-contained
 * page (pictures inlined, nothing external) for a sandboxed frame and takes
 * over when it lands. `pending` is true while the page is still being drawn,
 * and false once nothing more will arrive, with `html` null when the OS cannot
 * draw the file (the viewer then shows the extracted text).
 */
export interface OfficePage {
	readonly firstPage: string | null;
	readonly html: string | null;
	readonly pending: boolean;
}

/** Main -> preview window: a pending Office page progressed. */
export interface QuickLookOffice {
	readonly seq: number;
	readonly office: OfficePage;
}

/** Main -> preview window: the OS thumbnail for the current native document. */
export interface QuickLookThumbnail {
	readonly seq: number;
	readonly url: string;
}

/**
 * Main -> preview window: Keynote finished drawing some slides of the open deck
 * at full size. Each entry replaces the stored slide at `index`; `rendering`
 * goes false with the last update (which may carry no slides).
 */
export interface QuickLookSlides {
	readonly seq: number;
	readonly slides: readonly { readonly index: number; readonly bytes: Uint8Array }[];
	readonly rendering: boolean;
}

/** What the Finder knows of a selected file; the same identity keys the rendered-page cache. */
export interface PreviewPrefetch {
	readonly path: string;
	readonly mtimeMs: number;
	readonly size: number;
}

/** At most this many excerpts, each at most this long, travel with a preview request. */
export const ANCHOR_LIMITS = { excerpts: 32, chars: 8000 } as const;

export interface QuickLookTarget {
	readonly path: string;
	readonly name: string;
	/**
	 * Evidence excerpts to find and highlight (an AI Search citation); the
	 * viewer scrolls to the first one it finds. Absent for a plain preview.
	 */
	readonly anchor?: readonly string[];
}

/** One child of a previewed folder. */
export interface FolderItem {
	readonly name: string;
	readonly folder: boolean;
	readonly ext: string;
	readonly modifiedAt: string;
}

/** What a folder preview shows without walking the tree: its direct children. */
export interface FolderSummary {
	readonly name: string;
	readonly path: string;
	readonly modifiedAt: string;
	/** Visible (non-dot) direct children. */
	readonly itemCount: number;
	/** The most recently modified visible children, newest first. */
	readonly recent: readonly FolderItem[];
}

/**
 * A macOS application bundle: a directory the OS opens as one app, so the
 * preview shows the app itself rather than its contents.
 */
export interface BundleSummary {
	readonly name: string;
	readonly path: string;
	readonly modifiedAt: string;
	/** `autorag-thumb://` URL for the app's own icon; null keeps the app glyph. */
	readonly iconUrl: string | null;
}

/** `seq` orders loads; the main process ignores `ready` for a stale seq. Exactly one of `document`, `folder`, `bundle`, `error` is set. */
export interface QuickLookLoad {
	readonly seq: number;
	readonly name: string;
	readonly path: string;
	readonly document: PreviewDocument | null;
	readonly folder: FolderSummary | null;
	readonly bundle: BundleSummary | null;
	readonly error: string | null;
	/** Default app name when already known; otherwise it follows on the `app` channel. */
	readonly app: string | null;
	/** The target's excerpts to highlight, null for a plain preview. */
	readonly anchor: readonly string[] | null;
}

export interface QuickLookApp {
	readonly seq: number;
	readonly name: string | null;
}

/** Zero width or height means the content has no intrinsic size. */
export interface QuickLookReady {
	readonly seq: number;
	readonly width: number;
	readonly height: number;
	readonly fit: QuickLookFit;
}

export interface FileDetails {
	readonly createdAt: string;
	/** Enclosing folders from the volume down, e.g. ["Macintosh HD", "Users", "me"]. */
	readonly location: readonly string[];
	readonly binary: BinaryKind | null;
}

export interface FolderSize {
	readonly bytes: number;
	/** False when the walk stopped at its entry or time budget; `bytes` is then a lower bound. */
	readonly complete: boolean;
}

export interface AudioPicture {
	readonly mime: string;
	readonly data: Uint8Array;
}

export interface AudioMetadata {
	readonly title: string | null;
	readonly artist: string | null;
	readonly album: string | null;
	/** Seconds. */
	readonly duration: number | null;
	/** Bits per second. */
	readonly bitrate: number | null;
	/** Hz. */
	readonly sampleRate: number | null;
	readonly codec: string | null;
	readonly picture: AudioPicture | null;
}

/** One grid cell. Text is already capped; `blob` is the byte length of a binary value that is not sent. */
export type DataCell = string | null | { readonly blob: number };

export interface DataColumn {
	readonly name: string;
	/** Declared SQLite type or Parquet logical/physical type; may be empty. */
	readonly type: string;
}

export interface DataTable {
	readonly name: string;
	readonly view: boolean;
	/** Null for a view: counting it would run its stored query. */
	readonly rowCount: number | null;
	/** False when the count stopped at its cap: `rowCount` is then a lower bound. */
	readonly exact: boolean;
}

/** The columns and first rows of one table (or the first row group of a Parquet file). */
export interface DataRows {
	readonly name: string;
	readonly columns: readonly DataColumn[];
	readonly rows: readonly (readonly DataCell[])[];
	/** More rows exist than `rows` holds. */
	readonly more: boolean;
	/** Columns past the display cap were left out. */
	readonly columnsCut: boolean;
	/** Why no rows were read: the table failed, it is a view (its stored query is never run), or the Parquet row group is too large. */
	readonly failure: "table" | "view" | "too-large" | null;
}

/** `not-sqlite` also covers an encrypted database: without the key its header is noise. */
export type DataUnreadable = "not-sqlite" | "corrupt" | "not-parquet" | "encrypted";

export type DataPreview =
	| {
			readonly kind: "database";
			readonly tables: readonly DataTable[];
			readonly selected: DataRows | null;
			/** A non-empty `-wal` file sits beside the database; its newest commits are not shown. */
			readonly walPending: boolean;
	  }
	| {
			readonly kind: "parquet";
			readonly rowCount: number;
			readonly rowGroups: number;
			readonly createdBy: string | null;
			readonly selected: DataRows;
	  }
	| { readonly kind: "unreadable"; readonly reason: DataUnreadable };

/** Why an archive shows a note instead of its items. */
export type ArchiveUnreadable = "encrypted" | "corrupt" | "tooLarge" | "tooManyEntries" | "tooSlow";

/** An archive's top level as the main process read it: one entry per child (folders end in "/"). */
export type ArchivePreview =
	| { readonly kind: "entries"; readonly entries: readonly ArchiveEntry[] }
	| { readonly kind: "unreadable"; readonly reason: ArchiveUnreadable };

export type CertificateStatus = "valid" | "expired" | "notYetValid";

/** One X.509 certificate, decoded in the main process. Dates are ISO strings; fingerprints are colon-separated hex. */
export interface CertificateInfo {
	readonly subject: string;
	/** The subject's CN, or the whole subject when it has none. */
	readonly commonName: string;
	readonly issuer: string;
	readonly serial: string;
	readonly notBefore: string;
	readonly notAfter: string;
	readonly status: CertificateStatus;
	readonly signatureAlgorithm: string;
	readonly keyAlgorithm: string;
	/** RSA/DSA modulus size; null for curve keys. */
	readonly keyBits: number | null;
	/** Named curve of an EC key; null otherwise. */
	readonly curve: string | null;
	readonly subjectAltNames: readonly string[];
	/** keyUsage bits by name. */
	readonly keyUsage: readonly KeyUsageName[];
	/** Extended key usage OIDs; the page names the well-known ones. */
	readonly extendedKeyUsage: readonly string[];
	/** Whether OpenSSL accepts the certificate as a CA (basicConstraints, or a self-signed root without extensions). */
	readonly ca: boolean;
	readonly sha256: string;
	readonly sha1: string;
}

/**
 * One PEM block or the DER certificate of a file. A private key is only ever a
 * label and whether it is passphrase-protected (`null`: cannot tell); its body
 * never leaves the main process.
 */
export type CertificateEntry =
	| { readonly kind: "certificate"; readonly certificate: CertificateInfo }
	| { readonly kind: "privateKey"; readonly label: string; readonly encrypted: boolean | null }
	| { readonly kind: "other"; readonly label: string }
	| { readonly kind: "invalid"; readonly label: string };

/** The certificates and keys of a PEM or DER file. `omitted` counts entries past the cap; `truncated` says the file was longer than what was read. */
export interface CertificateList {
	readonly kind: "certificates";
	readonly source: "pem" | "der";
	readonly entries: readonly CertificateEntry[];
	readonly omitted: number;
	readonly truncated: boolean;
}

/** What the certificate panel draws, from `certificatePreview`. */
export type CertificatePreview =
	| CertificateList
	| { readonly kind: "container"; readonly container: "pkcs12" | "keychain"; readonly recognized: boolean }
	| { readonly kind: "unreadable"; readonly reason: "empty" | "notCertificate" };

export type QuickLookAction = "close" | "next" | "previous" | "open" | "fullscreen" | "reveal";

export type NavigateDelta = 1 | -1;

/**
 * Main -> preview zoom steps. `prepare` lays the panel out at its final size
 * inside the larger zoom window, posed at its start; `run` animates it;
 * `settle` drops the zoom styling once the window has its final bounds.
 */
export type QuickLookZoom =
	| { readonly id: number; readonly phase: "prepare"; readonly direction: ZoomDirection; readonly geometry: ZoomGeometry }
	| { readonly id: number; readonly phase: "run" | "settle" };

export interface QuickLookZoomed {
	readonly id: number;
	readonly phase: "prepared" | "done";
}

/** Exposed to the Finder window as `window.autorag.preview`. */
export interface PreviewBridge {
	/** `origin` is the file's icon in the Finder viewport (CSS pixels); null when it is not on screen. */
	show(target: QuickLookTarget, origin: Bounds | null): Promise<void>;
	hide(origin: Bounds | null): Promise<void>;
	/** The selected file's identity; the main process renders what the OS draws for it ahead of Space. */
	prefetch(file: PreviewPrefetch): void;
	onClosed(listener: () => void): () => void;
	onNavigate(listener: (delta: NavigateDelta) => void): () => void;
}

/** Exposed to the Quick Look window as `window.quickLook`. */
export interface QuickLookWindowBridge {
	readonly platform: string;
	/** The interface language the window started in. */
	readonly language: AppSettings["language"];
	onLanguage(listener: (language: AppSettings["language"]) => void): () => void;
	onLoad(listener: (load: QuickLookLoad) => void): () => void;
	onUnload(listener: () => void): () => void;
	onZoom(listener: (zoom: QuickLookZoom) => void): () => void;
	onApp(listener: (app: QuickLookApp) => void): () => void;
	onOffice(listener: (update: QuickLookOffice) => void): () => void;
	onSlides(listener: (update: QuickLookSlides) => void): () => void;
	onThumbnail(listener: (update: QuickLookThumbnail) => void): () => void;
	ready(report: QuickLookReady): void;
	zoomed(report: QuickLookZoomed): void;
	request(action: QuickLookAction): Promise<void>;
	/** The detail calls answer only for the file or folder the window is showing. */
	details(path: string): Promise<FileDetails>;
	sha256(path: string): Promise<string>;
	folderSize(path: string): Promise<FolderSize>;
	audioMetadata(path: string): Promise<AudioMetadata>;
	/** Database tables and first rows, or a Parquet file's schema and first rows. `table` picks a database table (null: the first). */
	dataPreview(path: string, table: string | null): Promise<DataPreview>;
	/** The top-level children of a 7z, RAR, tar.bz2/xz/zst, ISO, deb, rpm, or CAB; the page has no engine to read them itself. */
	archivePreview(path: string): Promise<ArchivePreview>;
	/** What a certificate or key file holds, read by the main process (`node:crypto`); never any private-key material. */
	certificatePreview(path: string): Promise<CertificatePreview>;
	/** `anchor` is the share button's rect in page CSS pixels. macOS only. */
	share(anchor: Bounds): Promise<void>;
	copyText(text: string): Promise<void>;
	/** A viewer that shows a text field (the PDF password prompt) reports whether it has one, so the window takes focus and Space and the arrows reach the field. */
	textEntry(active: boolean): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isOfficePage(value: unknown): value is OfficePage {
	if (!isRecord(value)) return false;
	return (value.firstPage === null || typeof value.firstPage === "string") && (value.html === null || typeof value.html === "string") && typeof value.pending === "boolean";
}

export function isQuickLookOffice(value: unknown): value is QuickLookOffice {
	return isRecord(value) && typeof value.seq === "number" && isOfficePage(value.office);
}

export function isQuickLookThumbnail(value: unknown): value is QuickLookThumbnail {
	return isRecord(value) && typeof value.seq === "number" && typeof value.url === "string";
}

export function isQuickLookSlides(value: unknown): value is QuickLookSlides {
	if (!isRecord(value) || typeof value.seq !== "number" || typeof value.rendering !== "boolean" || !Array.isArray(value.slides)) return false;
	return value.slides.every((entry: unknown) => isRecord(entry) && Number.isInteger(entry.index) && (entry.index as number) >= 0 && entry.bytes instanceof Uint8Array);
}

function isNativePreview(value: unknown): value is NativePreview {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	if (value.kind === "webloc") return typeof value.title === "string" && typeof value.url === "string";
	if (value.kind === "webarchive") return typeof value.html === "string";
	if (value.kind === "textclipping") return typeof value.text === "string";
	if (value.kind === "rtfd") return value.rtf instanceof Uint8Array && Array.isArray(value.attachments) && value.attachments.every((name) => typeof name === "string");
	if (value.kind === "iconset") return Array.isArray(value.icons) && value.icons.every((icon: unknown) => isRecord(icon) && typeof icon.name === "string" && icon.bytes instanceof Uint8Array);
	return false;
}

export function isPreviewDocument(value: unknown): value is PreviewDocument {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string" || typeof value.path !== "string" || typeof value.ext !== "string") return false;
	if (typeof value.size !== "number" || typeof value.modifiedAt !== "string" || typeof value.mime !== "string") return false;
	if (typeof value.truncated !== "boolean") return false;
	if (value.bytes !== null && !(value.bytes instanceof Uint8Array)) return false;
	if (value.office !== null && !isOfficePage(value.office)) return false;
	if (value.thumbnail !== null && typeof value.thumbnail !== "string") return false;
	if (value.native !== undefined && value.native !== null && !isNativePreview(value.native)) return false;
	if (value.package !== undefined && typeof value.package !== "boolean") return false;
	if (typeof value.slidesRendering !== "boolean") return false;
	return value.pages === null || (Array.isArray(value.pages) && value.pages.every((page) => page instanceof Uint8Array));
}

const CERTIFICATE_STATUSES: readonly unknown[] = ["valid", "expired", "notYetValid"];

function isStringList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCertificateInfo(value: unknown): value is CertificateInfo {
	if (!isRecord(value)) return false;
	const strings = [value.subject, value.commonName, value.issuer, value.serial, value.notBefore, value.notAfter, value.signatureAlgorithm, value.keyAlgorithm, value.sha256, value.sha1];
	if (!strings.every((item) => typeof item === "string")) return false;
	if (value.commonName === null) return false;
	if (!CERTIFICATE_STATUSES.includes(value.status)) return false;
	if (value.keyBits !== null && typeof value.keyBits !== "number") return false;
	if (value.curve !== null && typeof value.curve !== "string") return false;
	if (typeof value.ca !== "boolean") return false;
	return isStringList(value.subjectAltNames) && isStringList(value.keyUsage) && isStringList(value.extendedKeyUsage);
}

function isCertificateEntry(value: unknown): value is CertificateEntry {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case "certificate":
			return isCertificateInfo(value.certificate);
		case "privateKey":
			return typeof value.label === "string" && (value.encrypted === null || typeof value.encrypted === "boolean");
		case "other":
		case "invalid":
			return typeof value.label === "string";
		default:
			return false;
	}
}

export function isCertificatePreview(value: unknown): value is CertificatePreview {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case "certificates":
			return (
				(value.source === "pem" || value.source === "der") &&
				typeof value.omitted === "number" &&
				typeof value.truncated === "boolean" &&
				Array.isArray(value.entries) &&
				value.entries.every(isCertificateEntry)
			);
		case "container":
			return (value.container === "pkcs12" || value.container === "keychain") && typeof value.recognized === "boolean";
		case "unreadable":
			return value.reason === "empty" || value.reason === "notCertificate";
		default:
			return false;
	}
}

export function isPreviewPrefetch(value: unknown): value is PreviewPrefetch {
	return isRecord(value) && typeof value.path === "string" && value.path.length > 0 && Number.isFinite(value.mtimeMs) && Number.isFinite(value.size);
}

function isAnchor(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length <= ANCHOR_LIMITS.excerpts &&
		value.every((excerpt) => typeof excerpt === "string" && excerpt.length <= ANCHOR_LIMITS.chars)
	);
}

export function isQuickLookTarget(value: unknown): value is QuickLookTarget {
	if (!isRecord(value)) return false;
	if (value.anchor !== undefined && !isAnchor(value.anchor)) return false;
	return typeof value.path === "string" && value.path.length > 0 && typeof value.name === "string";
}

export function isBounds(value: unknown): value is Bounds {
	if (!isRecord(value)) return false;
	return [value.x, value.y, value.width, value.height].every((part) => typeof part === "number" && Number.isFinite(part));
}

export function isQuickLookZoom(value: unknown): value is QuickLookZoom {
	if (!isRecord(value) || typeof value.id !== "number") return false;
	if (value.phase === "run" || value.phase === "settle") return true;
	if (value.phase !== "prepare" || (value.direction !== "in" && value.direction !== "out")) return false;
	const geometry = value.geometry;
	if (!isRecord(geometry) || !isBounds(geometry.union) || !isBounds(geometry.from) || !isBounds(geometry.to)) return false;
	return (geometry.anchorX === "left" || geometry.anchorX === "right") && (geometry.anchorY === "top" || geometry.anchorY === "bottom");
}

export function isQuickLookZoomed(value: unknown): value is QuickLookZoomed {
	return isRecord(value) && typeof value.id === "number" && (value.phase === "prepared" || value.phase === "done");
}

function isFolderItem(value: unknown): value is FolderItem {
	if (!isRecord(value)) return false;
	return typeof value.name === "string" && typeof value.folder === "boolean" && typeof value.ext === "string" && typeof value.modifiedAt === "string";
}

export function isFolderSummary(value: unknown): value is FolderSummary {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string" || typeof value.path !== "string" || typeof value.modifiedAt !== "string") return false;
	return typeof value.itemCount === "number" && Array.isArray(value.recent) && value.recent.every(isFolderItem);
}

function isBundleSummary(value: unknown): value is BundleSummary {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string" || typeof value.path !== "string" || typeof value.modifiedAt !== "string") return false;
	return value.iconUrl === null || typeof value.iconUrl === "string";
}

export function isQuickLookLoad(value: unknown): value is QuickLookLoad {
	if (!isRecord(value)) return false;
	if (typeof value.seq !== "number" || typeof value.name !== "string" || typeof value.path !== "string") return false;
	if (value.document !== null && !isPreviewDocument(value.document)) return false;
	if (value.folder !== null && !isFolderSummary(value.folder)) return false;
	if (value.bundle !== null && !isBundleSummary(value.bundle)) return false;
	if (value.app !== null && typeof value.app !== "string") return false;
	if (value.anchor !== null && !isAnchor(value.anchor)) return false;
	return value.error === null || typeof value.error === "string";
}

export function isQuickLookApp(value: unknown): value is QuickLookApp {
	return isRecord(value) && typeof value.seq === "number" && (value.name === null || typeof value.name === "string");
}

export function isQuickLookReady(value: unknown): value is QuickLookReady {
	if (!isRecord(value)) return false;
	return (
		typeof value.seq === "number" &&
		typeof value.width === "number" &&
		Number.isFinite(value.width) &&
		typeof value.height === "number" &&
		Number.isFinite(value.height) &&
		(value.fit === "aspect" || value.fit === "clamp")
	);
}

export function isQuickLookAction(value: unknown): value is QuickLookAction {
	return value === "close" || value === "next" || value === "previous" || value === "open" || value === "fullscreen" || value === "reveal";
}

export function isNavigateDelta(value: unknown): value is NavigateDelta {
	return value === 1 || value === -1;
}

export const PREVIEW_SCHEME = "autorag-preview";

/** The remote bootstrap publishes this so scheme URLs become same-origin HTTP (see src/main/remote/bootstrap.ts). */
interface RemoteUrlProvider {
	readonly routes?: { readonly preview?: string };
	readonly url?: (route: string, params?: Readonly<Record<string, unknown>>) => string;
}

function remotePreviewUrl(filePath: string): string | null {
	const remote = Reflect.get(globalThis, "__autoragRemote") as RemoteUrlProvider | undefined;
	const route = remote?.routes?.preview;
	if (route === undefined || typeof remote?.url !== "function") return null;
	return remote.url(route, { path: filePath });
}

export function previewStreamUrl(filePath: string): string {
	const remote = remotePreviewUrl(filePath);
	if (remote !== null) return remote;
	const url = new URL(`${PREVIEW_SCHEME}://local/`);
	url.searchParams.set("path", filePath);
	return url.toString();
}

export function pathFromPreviewUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch (error) {
		if (error instanceof TypeError) return null;
		throw error;
	}
	if (url.protocol !== `${PREVIEW_SCHEME}:`) return null;
	const path = url.searchParams.get("path");
	if (path === null || path.length === 0 || path.includes("\0")) return null;
	return path;
}
