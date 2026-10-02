/**
 * Deterministic, throwaway fixtures for the Finder performance benchmark.
 *
 * Everything lives under a fresh temp directory and is removed by the caller;
 * the private user corpus is only ever read (via the supplied directories),
 * never written. The media bytes are real decodable files so Quick Look can
 * actually paint an image and a PDF.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A valid 1×1 PNG; Quick Look's <img> decodes it and reports naturalWidth. */
export const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** A square multi-page PDF with real page content; Quick Look renders each page to a canvas. */
export function minimalPdf(pageCount) {
	const fontId = 3 + pageCount * 2;
	const kids = [];
	const parts = [];
	parts[0] = "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n";
	for (let index = 0; index < pageCount; index += 1) {
		const pageId = 3 + index * 2;
		const contentId = pageId + 1;
		const stream = `BT /F1 24 Tf 60 300 Td (Page ${index + 1}) Tj ET`;
		kids.push(`${pageId} 0 R`);
		parts[pageId - 1] =
			`${pageId} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 600]/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>endobj\n`;
		parts[contentId - 1] = `${contentId} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj\n`;
	}
	parts[1] = `2 0 obj<</Type/Pages/Count ${pageCount}/Kids[${kids.join(" ")}]>>endobj\n`;
	parts[fontId - 1] = `${fontId} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`;
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (const part of parts) {
		offsets.push(body.length);
		body += part;
	}
	const xrefAt = body.length;
	let xref = `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) xref += String(offset).padStart(10, "0") + " 00000 n \n";
	body += `${xref}trailer<</Size ${parts.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return Buffer.from(body);
}

/** Writes `count` files with bounded concurrency so a 5k fixture stays cheap. */
async function writeMany(dir, count, makeName, makeBody) {
	const BATCH = 512;
	for (let start = 0; start < count; start += BATCH) {
		const end = Math.min(count, start + BATCH);
		await Promise.all(
			Array.from({ length: end - start }, (_unused, offset) => {
				const index = start + offset;
				return writeFile(join(dir, makeName(index)), makeBody(index));
			}),
		);
	}
}

/**
 * Builds the full fixture tree and returns the target paths the benchmark
 * navigates to. `stamp` keeps parallel runs from colliding.
 */
export async function createFixture(stamp) {
	const root = join(tmpdir(), `autorag-finder-perf-${stamp}`);
	const flat = join(root, "flat-5000");
	const normal = join(root, "normal-341");
	const media = join(root, "media");
	const nested = join(root, "nested");
	const nestedLevel1 = join(nested, "level-1");
	const nestedChild = join(nestedLevel1, "level-2");

	await mkdir(flat, { recursive: true });
	await mkdir(normal, { recursive: true });
	await mkdir(media, { recursive: true });
	await mkdir(nestedChild, { recursive: true });

	// flat-5000: the pure row-count stress for #16 virtualization.
	await writeMany(flat, 5000, (index) => `item-${String(index).padStart(5, "0")}.txt`, () => "x");

	// normal-341: a typical folder, mixed files and a couple of folders.
	await writeMany(normal, 341, (index) => `note-${String(index).padStart(4, "0")}.${index % 2 === 0 ? "txt" : "md"}`, () => "x");

	// media: the image/PDF-heavy fixture. `a-page.pdf` / `a-photo.png` sort to the
	// top so list-view locators always find them without scrolling.
	await writeFile(join(media, "a-page.pdf"), minimalPdf(3));
	await writeFile(join(media, "a-photo.png"), PNG_BYTES);
	await writeMany(media, 120, (index) => `img-${String(index).padStart(4, "0")}.png`, () => PNG_BYTES);
	await writeMany(media, 80, (index) => `doc-${String(index).padStart(4, "0")}.pdf`, () => minimalPdf(1));

	// nested: level-1 holds 300 folders (inline-disclosure stress for #17) and
	// level-2 holds 500 files (deeper-navigation stress).
	await writeMany(nested, 10, (index) => `root-${String(index).padStart(3, "0")}.txt`, () => "x");
	for (let index = 0; index < 300; index += 1) {
		const sub = join(nestedLevel1, `sub-${String(index).padStart(4, "0")}`);
		await mkdir(sub, { recursive: true });
		await writeFile(join(sub, "a.txt"), "x");
		await writeFile(join(sub, "b.txt"), "x");
	}
	await writeMany(nestedChild, 500, (index) => `child-${String(index).padStart(4, "0")}.md`, () => "x");

	return {
		root,
		flat,
		normal,
		media,
		nested,
		nestedLevel1,
		nestedChild,
		quickLook: { image: join(media, "a-photo.png"), pdf: join(media, "a-page.pdf") },
		// Recents seeds: spread across fixtures so the virtual listing is non-trivial.
		recents: [
			...Array.from({ length: 15 }, (_unused, index) => join(normal, `note-${String(index * 3).padStart(4, "0")}.${index * 3 % 2 === 0 ? "txt" : "md"}`)),
			join(media, "a-photo.png"),
			join(media, "a-page.pdf"),
		],
	};
}

/** Seeds the app-owned Recents store inside a throwaway user-data directory. */
export async function seedRecents(userDataDir, paths) {
	const directory = join(userDataDir, "recents");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "recents.json"), `${JSON.stringify(paths, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function removeFixture(root) {
	await rm(root, { recursive: true, force: true });
}
