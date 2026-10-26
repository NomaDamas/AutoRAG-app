/**
 * Manual QA — Quick Look for iWork packages and archives.
 *
 * Archives must read like the folder panel (same header, same "포함된 항목"
 * strip), and Numbers/Pages/Keynote files must show their first page. Builds a
 * fixture folder, drives the production build (`bun run build` first), opens
 * each file with Space from the Finder list, and checks the panel in the DOM.
 * The iWork thumbnail is checked through the Finder's own tile-tier icon.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { convertImage } from "./platform.mjs";

const EVIDENCE = process.argv[2] ?? "/tmp/autorag-quicklook-archives";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-archives-"));

// A real JPEG: iWork stores the first page as `preview.jpg`.
const seedPath = join(root, "seed.png");
const jpegPath = join(root, "page.jpg");
writeFileSync(seedPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
convertImage(seedPath, jpegPath, { width: 640, height: 360 });
const page = new Uint8Array(readFileSync(jpegPath));
rmSync(seedPath);
rmSync(jpegPath);

const iwork = (extra) => zipSync({ "Index/Document.iwa": new Uint8Array(2048), "preview.jpg": page, "preview-web.jpg": page, ...extra }, { level: 0 });
writeFileSync(join(root, "Budget.numbers"), iwork({}));
writeFileSync(join(root, "Pitch.key"), iwork({}));
writeFileSync(join(root, "Letter.pages"), iwork({}));
writeFileSync(join(root, "Bare.numbers"), zipSync({ "Index/Document.iwa": strToU8("x") }));

const when = (day) => ({ mtime: new Date(2026, 8, day, 12) });
writeFileSync(
	join(root, "bundle.zip"),
	zipSync({
		"src/main.py": [strToU8("print(1)"), when(2)],
		"src/util/helpers.py": [strToU8("x"), when(20)],
		"README.md": [strToU8("# hi"), when(10)],
		"data.csv": [strToU8("a,b\n1,2\n"), when(5)],
		"photo.png": [new Uint8Array(64), when(8)],
		"report.pdf": [new Uint8Array(64), when(3)],
		"notes.txt": [strToU8("n"), when(1)],
		"__MACOSX/._README.md": [strToU8("x"), when(30)],
	}),
);
mkdirSync(join(root, "tarsrc", "inner"), { recursive: true });
writeFileSync(join(root, "tarsrc", "a.txt"), "hello");
writeFileSync(join(root, "tarsrc", "inner", "b.txt"), "world");
execFileSync("tar", ["-cf", join(root, "bundle.tar"), "-C", join(root, "tarsrc"), "."]);
execFileSync("tar", ["-czf", join(root, "bundle.tgz"), "-C", join(root, "tarsrc"), "."]);
rmSync(join(root, "tarsrc"), { recursive: true });
mkdirSync(join(root, "Projects", "inner"), { recursive: true });
writeFileSync(join(root, "Projects", "a.txt"), "a");

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

async function poll(read, accept, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		value = await read();
	}
	return value;
}

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: "ko" });
try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html")),
		(candidate) => candidate !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const bounds = () =>
		app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			return window === undefined ? null : { visible: window.isVisible(), bounds: window.getBounds() };
		});

	async function open(name, ready, arg) {
		const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		await poll(() => preview.evaluate(ready, arg).catch(() => false), Boolean, 10_000);
		await poll(async () => (await bounds())?.visible === true, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => (await bounds())?.visible === false, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const texts = (selector) => preview.locator(selector).evaluateAll((nodes) => nodes.map((node) => node.textContent));

	// Folder reference: the panel archives must match.
	await open("Projects", () => document.querySelector(".ql-folder__name")?.textContent === "Projects");
	const folderBounds = (await bounds())?.bounds;
	const folderHeader = await preview.locator(".ql-folder > div:first-child").evaluate((node) => node.getBoundingClientRect().height);
	await preview.screenshot({ path: join(EVIDENCE, "folder.png") });
	await close();

	// ZIP
	await open("bundle.zip", () => document.querySelector(".ql-archive__name")?.textContent === "bundle.zip");
	check("zip shows the folder-style header", ((await preview.locator(".ql-archive").textContent()) ?? "").includes("ZIP archive"));
	const zipCount = (await preview.locator(".ql-archive__count").textContent()) ?? "";
	check("zip counts top-level items, not every entry", /^6(\s?items|개 항목),? /u.test(zipCount), zipCount);
	const zipItems = await texts(".ql-archive__items > div > span");
	check("zip lists newest top-level children first, forks hidden", JSON.stringify(zipItems) === JSON.stringify(["src", "README.md", "photo.png", "data.csv", "report.pdf", "notes.txt"]), JSON.stringify(zipItems));
	const zipBounds = (await bounds())?.bounds;
	check("zip panel has the folder panel's size", zipBounds?.width === folderBounds?.width && zipBounds?.height === folderBounds?.height, `${JSON.stringify(zipBounds)} vs ${JSON.stringify(folderBounds)}`);
	const zipHeader = await preview.locator(".ql-archive > div:first-child").evaluate((node) => node.getBoundingClientRect().height);
	check("zip header is as tall as the folder header", zipHeader === folderHeader, `${zipHeader} vs ${folderHeader}`);
	check("zip shows the 포함된 항목 box", ((await preview.locator(".ql-archive").textContent()) ?? "").includes("최근 수정 순 · 6 / 6"));
	await preview.screenshot({ path: join(EVIDENCE, "zip.png") });
	await close();

	for (const name of ["bundle.tar", "bundle.tgz"]) {
		await open(name, (expected) => document.querySelector(".ql-archive__name")?.textContent === expected, name);
		const items = await texts(".ql-archive__items > div > span");
		check(`${name} lists its top level like a folder`, items.length === 2 && items.includes("a.txt") && items.includes("inner"), JSON.stringify(items));
		await close();
	}

	// iWork
	for (const [name, kind] of [["Budget.numbers", "Numbers spreadsheet"], ["Pitch.key", "Keynote presentation"], ["Letter.pages", "Pages document"]]) {
		await open(name, () => {
			const image = document.querySelector("img.ql__image");
			return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
		});
		const shown = await preview.locator("img.ql__image").evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
		check(`${name} shows its first page`, shown.width === 640 && shown.height === 360, JSON.stringify(shown));
		check(`${name} is not an archive listing`, (await preview.locator(".ql-archive").count()) === 0);
		console.log(`      kind: ${kind}`);
		await preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });
		await close();
	}
	await open("Bare.numbers", () => document.querySelector(".ql-other__name")?.textContent === "Bare.numbers");
	check("package without an image falls back to the Other panel", ((await preview.locator(".ql__note").textContent()) ?? "").includes("미리보기 이미지가 없습니다"));
	await close();
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
