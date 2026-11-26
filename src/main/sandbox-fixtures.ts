import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";

const MAX_SNAPSHOT_ENTRIES = 200;
const MAX_PREVIEW_BYTES = 4096;

/** Valid 16x16 solid red JPEG for binary image sandbox fixtures. */
const SAMPLE_RED_JPG_BASE64 =
	"/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYzLjI0LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z";

/** Valid 16x16 solid red PNG for binary image sandbox fixtures. */
const SAMPLE_RED_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAF0lEQVR4nGP8x0AaYCFR/aiGUQ1DSAMAaw8BPJLkRBUAAAAASUVORK5CYII=";

export interface SandboxFixtureInput {
	/** Relative path inside the sandbox folder (e.g. `sample.md` or `sub/note.txt`). */
	readonly path: string;
	/** File content (UTF-8 text). Ignored when `base64` is provided or `kind === "folder"`. */
	readonly content?: string;
	/** Optional raw binary bytes encoded as base64. */
	readonly base64?: string;
	readonly kind?: "file" | "folder";
}

export interface SandboxFileSnapshot {
	readonly path: string;
	readonly kind: "file" | "folder";
	readonly size?: number;
	readonly contentPreview?: string;
}

export interface SandboxDiff {
	readonly created: readonly SandboxFileSnapshot[];
	readonly modified: readonly SandboxFileSnapshot[];
	readonly deleted: readonly string[];
	readonly unchanged: readonly string[];
}

interface InternalSnapshotEntry {
	readonly kind: "file" | "folder";
	readonly size?: number;
	readonly bytes?: Buffer;
	readonly contentPreview?: string;
}

/** Resolve a fixture path strictly inside `sandboxRoot`, refusing escapes (`..` or absolute paths). */
export function resolveSandboxPath(sandboxRoot: string, relPath: string): string {
	const trimmed = relPath.trim();
	if (trimmed.length === 0) throw new Error("Sandbox fixture path must not be empty.");
	if (isAbsolute(trimmed)) throw new Error(`Sandbox fixture path must be relative: ${trimmed}`);
	const target = resolve(sandboxRoot, trimmed);
	const rel = relative(sandboxRoot, target);
	if (rel === "" || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Sandbox fixture path escapes sandbox: ${trimmed}`);
	}
	return target;
}

async function createSamplePdfBytes(index: number): Promise<Buffer> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([420, 240]);
	page.drawText(`Sample PDF Document ${index}`, { x: 24, y: 190, size: 16, font });
	page.drawText("Action item: verify sandbox processing works as expected.", { x: 24, y: 155, size: 11, font });
	page.drawText("Date: 2026-11-26  Owner: Sandbox QA", { x: 24, y: 130, size: 11, font });
	return Buffer.from(await doc.save());
}

function createSampleDocxBytes(index: number): Buffer {
	const contentTypes =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
		"</Types>";
	const rels =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
		"</Relationships>";
	const documentXml =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
		`<w:p><w:r><w:t>Sample Word Document ${index}</w:t></w:r></w:p>` +
		"<w:p><w:r><w:t>Action item: verify sandbox processing works as expected.</w:t></w:r></w:p>" +
		"</w:body></w:document>";
	return Buffer.from(
		zipSync({
			"[Content_Types].xml": strToU8(contentTypes),
			"_rels/.rels": strToU8(rels),
			"word/document.xml": strToU8(documentXml),
		}),
	);
}

function createSampleZipBytes(index: number): Buffer {
	return Buffer.from(
		zipSync({
			[`note-${index}.txt`]: strToU8(`Sample archive entry ${index}\n`),
		}),
	);
}

/**
 * Generate realistic, format-valid sample bytes for common extensions so PDF/DOCX/PNG/JPG/ZIP
 * actions and automations can actually read, parse, inspect, or convert the fixture in a temp folder.
 */
export async function generateSampleFileBytes(fileName: string, index = 1): Promise<Buffer> {
	const ext = extname(fileName).toLowerCase().replace(/^\./u, "");
	switch (ext) {
		case "pdf":
			return createSamplePdfBytes(index);
		case "docx":
			return createSampleDocxBytes(index);
		case "zip":
			return createSampleZipBytes(index);
		case "png":
			return Buffer.from(SAMPLE_RED_PNG_BASE64, "base64");
		case "jpg":
		case "jpeg":
			return Buffer.from(SAMPLE_RED_JPG_BASE64, "base64");
		case "json":
			return Buffer.from(`${JSON.stringify({ sample: index, status: "ok", items: ["alpha", "beta"] }, null, 2)}\n`, "utf8");
		case "csv":
			return Buffer.from(`name,value\nitem-${index},${index * 10}\nitem-${index + 1},${(index + 1) * 10}\n`, "utf8");
		case "md":
		case "markdown":
			return Buffer.from(
				`# Sample Document ${index}\n\n- Action item ${index}: verify workflow in sandbox\n- Owner: Dazzi QA\n`,
				"utf8",
			);
		case "html":
		case "htm":
			return Buffer.from(`<!doctype html><html><body><h1>Sample ${index}</h1><p>Sandbox verification.</p></body></html>\n`, "utf8");
		default:
			return Buffer.from(`Sample file ${index} content\nLine two of sample ${index}\n`, "utf8");
	}
}

/**
 * Produce a concrete relative path that matches a glob pattern such as `**\/*.pdf`,
 * `**\/IMG_*.jpg`, `docs/*.md`, `*.{png,jpg}`, or `report-??.txt`.
 */
export function sampleFilenameForGlob(pattern: string, index = 1): string {
	let cleaned = pattern.trim().replaceAll("\\", "/");
	// Strip leading recursive wildcards (`**/`) and leading slashes
	while (cleaned.startsWith("**/")) cleaned = cleaned.slice(3);
	cleaned = cleaned.replace(/^\/+/u, "");
	if (cleaned === "" || cleaned === "**" || cleaned === "*" || cleaned === "**/*") {
		return index === 1 ? "sample.txt" : `sample-${index}.txt`;
	}
	// Expand brace alternatives `{a,b}` to the first choice
	cleaned = cleaned.replace(/\{([^{}]+)\}/gu, (_full, body: string) => {
		const first = body.split(",")[0]?.trim() ?? "";
		return first;
	});
	// Expand character classes `[0-9]` / `[a-z]` to a concrete character
	cleaned = cleaned.replace(/\[([^\]]+)\]/gu, (_full, cls: string) => {
		const first = cls.replace(/^\^/u, "")[0] ?? "a";
		return /[A-Za-z0-9_-]/u.test(first) ? first : "a";
	});
	const segments = cleaned
		.split("/")
		.filter((seg) => seg.length > 0 && seg !== "**" && seg !== "." && seg !== "..");
	if (segments.length === 0) return index === 1 ? "sample.txt" : `sample-${index}.txt`;

	const numTag = String(index).padStart(4, "0");
	const mapped = segments.map((seg, segIdx) => {
		const isLast = segIdx === segments.length - 1;
		if (seg === "*") return isLast ? `sample-${index}.txt` : "sub";
		let out = seg;
		let qCount = 0;
		out = out.replace(/\?/gu, () => {
			qCount += 1;
			return String((index + qCount - 1) % 10);
		});
		if (out.includes("*")) {
			// Replace wildcards with a clean token; if preceded by `_` or `-` (like `IMG_*.jpg`), use digits
			out = out.replace(/\*+/gu, (_m, offset: number, full: string) => {
				const prev = offset > 0 ? full[offset - 1] : "";
				if (prev === "_" || prev === "-") return numTag;
				return offset === 0 && full.startsWith("*.") ? (index === 1 ? "sample" : `sample-${index}`) : `sample${index}`;
			});
		}
		return out;
	});
	const joined = mapped.join("/");
	// Guard against accidentally ending in a bare name with no safe path
	return joined.length > 0 ? joined : `sample-${index}.txt`;
}

export async function seedSandboxFixtures(
	sandboxRoot: string,
	fixtures: readonly SandboxFixtureInput[],
): Promise<string[]> {
	const createdPaths: string[] = [];
	let fileIndex = 0;
	for (const fixture of fixtures) {
		const target = resolveSandboxPath(sandboxRoot, fixture.path);
		if (fixture.kind === "folder") {
			await mkdir(target, { recursive: true });
		} else {
			fileIndex += 1;
			await mkdir(dirname(target), { recursive: true });
			if (fixture.base64 !== undefined) {
				await writeFile(target, Buffer.from(fixture.base64, "base64"));
			} else if (fixture.content !== undefined) {
				await writeFile(target, fixture.content, "utf8");
			} else {
				const bytes = await generateSampleFileBytes(target, fileIndex);
				await writeFile(target, bytes);
			}
		}
		createdPaths.push(target);
	}
	return createdPaths;
}

async function readTextPreview(filePath: string): Promise<string | undefined> {
	try {
		const buf = await readFile(filePath);
		const slice = buf.subarray(0, MAX_PREVIEW_BYTES);
		if (slice.includes(0)) return undefined;
		const text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
		return buf.length > MAX_PREVIEW_BYTES ? `${text}\n… (${buf.length} bytes total)` : text;
	} catch {
		return undefined;
	}
}

export async function snapshotDirectory(rootDir: string): Promise<Map<string, InternalSnapshotEntry>> {
	const map = new Map<string, InternalSnapshotEntry>();
	const walk = async (dir: string): Promise<void> => {
		if (map.size >= MAX_SNAPSHOT_ENTRIES) return;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (map.size >= MAX_SNAPSHOT_ENTRIES) return;
			const full = join(dir, entry.name);
			const rel = relative(rootDir, full).replaceAll("\\", "/");
			if (entry.isDirectory()) {
				map.set(rel, { kind: "folder" });
				await walk(full);
			} else if (entry.isFile()) {
				const st = await lstat(full).catch(() => null);
				const raw = await readFile(full).catch(() => undefined);
				const contentPreview = raw === undefined ? undefined : await readTextPreview(full);
				map.set(rel, {
					kind: "file",
					...(st !== null ? { size: st.size } : {}),
					...(raw !== undefined ? { bytes: raw } : {}),
					...(contentPreview !== undefined ? { contentPreview } : {}),
				});
			}
		}
	};
	await walk(rootDir);
	return map;
}

export function diffSnapshots(
	before: ReadonlyMap<string, InternalSnapshotEntry>,
	after: ReadonlyMap<string, InternalSnapshotEntry>,
): SandboxDiff {
	const created: SandboxFileSnapshot[] = [];
	const modified: SandboxFileSnapshot[] = [];
	const deleted: string[] = [];
	const unchanged: string[] = [];

	for (const [rel, entry] of after) {
		const prev = before.get(rel);
		if (prev === undefined) {
			created.push({
				path: rel,
				kind: entry.kind,
				...(entry.size !== undefined ? { size: entry.size } : {}),
				...(entry.contentPreview !== undefined ? { contentPreview: entry.contentPreview } : {}),
			});
			continue;
		}
		const same =
			prev.kind === entry.kind &&
			prev.size === entry.size &&
			(prev.bytes === undefined && entry.bytes === undefined
				? true
				: prev.bytes !== undefined && entry.bytes !== undefined && prev.bytes.equals(entry.bytes));
		if (same) {
			unchanged.push(rel);
		} else {
			modified.push({
				path: rel,
				kind: entry.kind,
				...(entry.size !== undefined ? { size: entry.size } : {}),
				...(entry.contentPreview !== undefined ? { contentPreview: entry.contentPreview } : {}),
			});
		}
	}

	for (const rel of before.keys()) {
		if (!after.has(rel)) deleted.push(rel);
	}

	return { created, modified, deleted, unchanged };
}
