/**
 * Manual QA — the Apple-only package views (issue #354) in the BUILT Finder.
 *
 * Six extensions get a real viewer instead of a folder listing or a bare info
 * panel: `.webloc`/`.inetloc` (an internet location), `.webarchive` (a saved
 * page), `.rtfd` (a rich-text package), `.iconset` (a folder of PNGs), and
 * `.textclipping` (an XML plist or plain UTF-8 clipping). The macOS-only
 * extensions (`.pvt`, `.lpdf`, `.prefpane`, `.pict`, …) keep the OS rendering:
 * on macOS the info panel shows the thumbnail Quick Look draws for them, and
 * everywhere else the panel keeps its glyph.
 *
 * This lane drives the production build (out/) the way the other Quick Look
 * lanes do — click the row, press Space — against real fixtures, and proves:
 *   1. each viewer opens for its own file, with its own stage kind;
 *   2. a package that is a directory on disk (`Notes.rtfd`, `App.iconset`,
 *      `Settings.prefpane`) is listed as a FILE row and previews as one
 *      document — never the folder listing of its contents;
 *   3. the hostile web archive opens in a `sandbox=""` frame whose document has
 *      no script, no event handler, and no remote URL, carries its own CSP,
 *      inlines the archived picture and stylesheet, and whose text really
 *      paints (pixel check); neither the frame nor the page ever asks
 *      evil.example or remote.example for anything, proven by a main-process
 *      `session.webRequest` hook and by the page's own network log;
 *   4. the RTFD viewer shows its text and lists, but does not draw, its
 *      attachments; the iconset viewer draws its PNGs as images, not as a
 *      folder grid;
 *   5. the native-only formats fall back to the info panel with the OS
 *      thumbnail on macOS (those checks are skipped on other platforms);
 *   6. the `.webloc` Open button hands that exact path to `shell.openPath`;
 *      the QA guard records the call instead of launching a real browser, and
 *      no other external open occurs;
 *   7. the Interface language reaches the viewers: after switching the app to
 *      한국어 through the real Settings UI (a real `select` change, no injected
 *      app state), the reopened `.webloc` and `Empty.bin` panels answer in
 *      Korean. If that navigation is ever too brittle, the failure is reported
 *      here rather than silently skipped.
 *
 * Fixtures: a temp QA root passed through AUTORAG_QA_ROOT. The hostile web
 * archive and the 1×1 PNG it carries are the ones from
 * `test/preview-apple-packages.test.ts`; the PNG is read back out of the
 * archive at run time, so its bytes are not duplicated here.
 * Evidence: $QA_OUT (or argv[2]), else .omo/evidence/ai-finder-app/apple-packages/.
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-quick-look-apple-packages.mjs
 * Exit code: 0 when every check passed, 1 otherwise.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { chord, cssAttr } from "./platform.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const EVIDENCE = process.env.QA_OUT?.trim() || process.argv[2] || join(REPO, ".omo", "evidence", "ai-finder-app", "apple-packages");
const WORK = mkdtempSync(join(tmpdir(), "autorag-ql-apple-packages-"));
const ROOT = join(WORK, "ApplePackagesQA");
const DARWIN = process.platform === "darwin";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The hostile saved page from test/preview-apple-packages.test.ts, byte for byte. */
const HOSTILE_ARCHIVE = Buffer.from(
	"YnBsaXN0MDDSAQIDCl8QD1dlYk1haW5SZXNvdXJjZV8QD1dlYlN1YnJlc291cmNlc9MEBQYHCAleV2ViUmVzb3VyY2VVUkxfEBNXZWJSZXNvdXJjZU1JTUVUeXBlXxAPV2ViUmVzb3VyY2VEYXRhXxAfaHR0cHM6Ly9ldmlsLmV4YW1wbGUvaW5kZXguaHRtbFl0ZXh0L2h0bWxPEQEyPGh0bWw+PGhlYWQ+PHNjcmlwdD5mZXRjaCgiaHR0cHM6Ly9ldmlsLmV4YW1wbGUvYmVhY29uIik8L3NjcmlwdD48bGluayByZWw9InN0eWxlc2hlZXQiIGhyZWY9Imh0dHBzOi8vZXZpbC5leGFtcGxlL3N0eWxlLmNzcyI+PC9oZWFkPjxib2R5IG9ubG9hZD0iZmV0Y2goJ2h0dHBzOi8vZXZpbC5leGFtcGxlL29ubG9hZCcpIj48aW1nIHNyYz0iaHR0cHM6Ly9ldmlsLmV4YW1wbGUvcGl4ZWwucG5nIj48aW1nIHNyYz0iaHR0cHM6Ly9yZW1vdGUuZXhhbXBsZS90cmFja2VyLnBuZyI+PHA+U2FmZSBhcmNoaXZlPC9wPjwvYm9keT48L2h0bWw+ogsP0wQFBgwNDl8QHmh0dHBzOi8vZXZpbC5leGFtcGxlL3BpeGVsLnBuZ1lpbWFnZS9wbmdPEEaJUE5HDQoaCgAAAA1JSERSAAAAAQAAAAEIBgAAAB8VxIkAAAANSURBVHjaY/zPwFAPAASFAYCEqYwhAAAAAElFTkSuQmCC0wQFBhAREl8QHmh0dHBzOi8vZXZpbC5leGFtcGxlL3N0eWxlLmNzc1h0ZXh0L2Nzc08QFWJvZHl7YmFja2dyb3VuZDojZmZmfQAIAA0AHwAxADgARwBdAG8AkQCbAdEB1AHbAfwCBgJPAlYCdwKAAAAAAAAAAgEAAAAAAAAAEwAAAAAAAAAAAAAAAAAAApg=",
	"base64",
);

/** The same XML internet location the unit test reads. */
const XML_LINK = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>https://example.com/docs?q=1&amp;x=2</string></dict></plist>`;
const LINK_URL = "https://example.com/docs?q=1&x=2";

/** `{ \rtf1 … }` whose text the RTFD viewer must print. */
const RTF_BODY = "{\\rtf1\\ansi\\deff0 Notes RTFD body\\par Second line\\par}";

/**
 * The 1×1 PNG the hostile archive embeds, sliced back out of it by its chunks:
 * the iconset reuses those exact bytes instead of carrying a second copy.
 */
function pngBytesOf(archive) {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const start = archive.indexOf(signature);
	if (start < 0) throw new Error("the hostile archive carries no PNG");
	let offset = start + 8;
	for (;;) {
		if (offset + 8 > archive.length) throw new Error("the archive's PNG is truncated");
		const length = archive.readUInt32BE(offset);
		const type = archive.toString("ascii", offset + 4, offset + 8);
		offset += 12 + length;
		if (type === "IEND") return archive.subarray(start, offset);
	}
}

/** Binary junk with NUL bytes, so the panel keeps the info view instead of reading it as text. */
function binaryFixture(bytes) {
	const buffer = Buffer.alloc(bytes);
	for (let index = 0; index < bytes; index += 1) buffer[index] = (index * 37 + 11) % 256;
	return buffer;
}

const PNG = pngBytesOf(HOSTILE_ARCHIVE);

rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });
mkdirSync(ROOT, { recursive: true });

const fixture = (name) => join(ROOT, name);
const write = (name, content) => writeFileSync(fixture(name), content);

// An internet location: an XML plist the panel shows without navigating to it.
write("Example.webloc", XML_LINK);
// A saved page whose every resource points at evil.example or remote.example.
write("Hostile.webarchive", HOSTILE_ARCHIVE);
// A rich-text package: a directory on disk that must preview as one document.
mkdirSync(fixture("Notes.rtfd"));
write("Notes.rtfd/TXT.rtf", RTF_BODY);
write("Notes.rtfd/photo.png", PNG);
write("Notes.rtfd/.DS_Store", "hidden entry the panel must not list");
// An iconset: two PNGs (sorted names) plus a non-PNG that must be ignored.
mkdirSync(fixture("App.iconset"));
write("App.iconset/icon_16x16.png", PNG);
write("App.iconset/icon_32x32.png", PNG);
write("App.iconset/README.txt", "not a PNG\n");
// A clipping property list and a plain UTF-8 clipping.
write("Clip.textclipping", `<?xml version="1.0"?><plist><dict><key>public.utf8-plain-text</key><string>Clipped text</string></dict></plist>`);
write("Plain.textclipping", "Plain clipped text");
// Native-only formats: macOS renders these, no cross-platform decoder claims them.
mkdirSync(fixture("Live.pvt"));
write("Live.pvt/Info.plist", '<?xml version="1.0"?><plist><dict><key>CFBundleName</key><string>Live</string></dict></plist>');
write("Live.pvt/still.png", PNG);
write("Empty.bin", "");
write("Legacy.pict", binaryFixture(2048));
mkdirSync(fixture("Localized.lpdf"));
write("Localized.lpdf/Info.plist", '<?xml version="1.0"?><plist><dict><key>CFBundleName</key><string>Localized</string></dict></plist>');
write("Localized.lpdf/Localizable.pdf", "%PDF-1.4\n%%EOF\n");
mkdirSync(fixture("Settings.prefpane/Contents"), { recursive: true });
write(
	"Settings.prefpane/Contents/Info.plist",
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0"><dict>',
		"<key>CFBundleIdentifier</key><string>com.example.autorag.qa-prefpane</string>",
		"<key>CFBundleName</key><string>Settings</string>",
		"</dict></plist>",
	].join("\n"),
);

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass: Boolean(pass) });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}
function info(label, value) {
	console.log(`INFO  ${label}: ${value}`);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`INFO  platform ${process.platform}; fixtures in ${ROOT}`);
console.log(`INFO  evidence ${EVIDENCE}`);

// ---------------------------------------------------------------------------
// Drive the built app
// ---------------------------------------------------------------------------

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: ROOT, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: "en" });
try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((page) => page.url().includes("quick-look.html")),
		(page) => page !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("the Quick Look window did not pre-warm");

	/** Every request either window makes, for the "nothing was fetched" proof. */
	const pageRequests = [];
	for (const page of [main, preview]) page.on("request", (request) => pageRequests.push(request.url()));

	// Main-process instrumentation: the default session's own request log, and a
	// guard that records (instead of performing) any external launch, so the lane
	// can assert the `.webloc` Open button was never pressed for real.
	const instruments = await app.evaluate(({ session, shell, nativeImage }) => {
		globalThis.__qaRequests = [];
		session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
			globalThis.__qaRequests.push(details.url);
			callback({});
		});
		globalThis.__qaLaunches = [];
		const openPath = shell.openPath;
		const openExternal = shell.openExternal;
		shell.openPath = async (path) => {
			globalThis.__qaLaunches.push({ via: "openPath", path });
			return "";
		};
		shell.openExternal = async (url) => {
			globalThis.__qaLaunches.push({ via: "openExternal", url });
		};
		const createThumbnail = nativeImage.createThumbnailFromPath;
		nativeImage.createThumbnailFromPath = async (path, size) => {
			if (path.endsWith(".pict")) await new Promise((resolve) => setTimeout(resolve, 4500));
			return createThumbnail.call(nativeImage, path, size);
		};
		return {
			hooked: Array.isArray(globalThis.__qaRequests),
			launchesGuarded: shell.openPath !== openPath && shell.openExternal !== openExternal,
			slowThumbnail: nativeImage.createThumbnailFromPath !== createThumbnail,
		};
	});
	check("the main-process request log is installed", instruments.hooked === true, JSON.stringify(instruments));
	check("the slow native-thumbnail probe is installed", instruments.slowThumbnail === true, JSON.stringify(instruments));

	const visible = () =>
		app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.webContents.getURL().includes("quick-look.html") && window.isVisible()));
	const rowFor = (name) => main.locator(`[role="row"][data-path="${cssAttr(fixture(name))}"]`).first();
	const stage = (kind) => () =>
		preview
			.locator(`.ql__stage[data-kind="${kind}"]`)
			.count()
			.then((value) => value > 0)
			.catch(() => false);
	const showing = (name) => () =>
		preview
			.locator(".ql-other__name")
			.innerText()
			.then((value) => value.trim() === name)
			.catch(() => false);
	const count = (selector) => preview.locator(selector).count().catch(() => 0);
	const text = (selector) => preview.locator(selector).first().innerText().catch(() => "");
	const shot = (name) => preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	const notFolder = async () => (await count(".ql-folder")) === 0 && (await count(".ql-folder__items")) === 0;

	/** Click the row, press Space, and wait for the panel that file is supposed to open. */
	async function open(name, ready) {
		const row = rowFor(name);
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		if ((await poll(visible, Boolean, 15_000)) !== true) {
			info(`${name} panel`, "did not show on the first Space; pressing Space again");
			await main.keyboard.press("Space");
			await poll(visible, Boolean, 10_000);
		}
		await poll(ready, Boolean, 25_000);
		await sleep(400);
	}
	/** Wait for a row to be mounted before reading its cells (the list is virtualized). */
	async function rowIsFile(name) {
		await rowFor(name).waitFor({ timeout: 30_000 });
		return (await rowFor(name).locator(".tile--folder").count()) === 0;
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => (await visible()) === false, Boolean, 8000);
		await sleep(250);
	}

	// -----------------------------------------------------------------------
	// 1. The internet location: shown, never followed, and its Open button waits.
	// -----------------------------------------------------------------------
	await rowFor("Example.webloc").waitFor({ timeout: 30_000 });
	check("the QA root lists Example.webloc", (await rowFor("Example.webloc").count()) === 1, String(await rowFor("Example.webloc").count()));
	await open("Example.webloc", stage("webloc"));
	check("Space opens the internet-location panel", (await count(".ql-webloc")) === 1, String(await count(".ql-webloc")));
	const linkTitle = (await text(".ql-webloc__title")).trim();
	check("the panel titles the link by its file name", linkTitle === "Example", linkTitle);
	const linkUrl = (await text(".ql-webloc__url")).trim();
	check("the panel shows the location the plist holds", linkUrl === LINK_URL, linkUrl);
	check("the internet location is not a folder listing", await notFolder(), "");
	check("the panel offers the Open button", (await count(".qlw__open")) === 1, String(await count(".qlw__open")));
	const openLabel = (await text(".qlw__open")).trim();
	check("the Open button reads as an opener for the default app", /^Open\b/u.test(openLabel), openLabel);
	check("showing the link did not navigate the preview window", preview.url().includes("quick-look.html"), preview.url());
	await shot("webloc");
	if (instruments.launchesGuarded) {
		await preview.locator(".qlw__open").click();
		const linkLaunch = await poll(
			() => app.evaluate(() => globalThis.__qaLaunches ?? []),
			(launches) => launches.length === 1,
			5000,
		);
		check(
			"Open hands the internet location to the OS opener",
			linkLaunch.length === 1 && linkLaunch[0]?.via === "openPath" && linkLaunch[0]?.path === fixture("Example.webloc"),
			JSON.stringify(linkLaunch),
		);
	} else {
		info("internet-location Open", "not pressed because the external-launch guard could not be installed");
	}
	await close();

	// -----------------------------------------------------------------------
	// 2. The hostile saved page.
	// -----------------------------------------------------------------------
	const requestsBeforeArchive = pageRequests.length;
	await open("Hostile.webarchive", stage("webarchive"));
	await sleep(1200);
	const frame = await preview.evaluate(() => {
		const element = document.querySelector("iframe.ql-webarchive");
		if (element === null) return null;
		return { sandbox: element.getAttribute("sandbox"), srcdoc: element.getAttribute("srcdoc") ?? "", onload: element.hasAttribute("onload") };
	});
	check("the archive opens in an iframe", frame !== null, JSON.stringify(frame === null ? null : { sandbox: frame.sandbox }));
	check("the frame is sandboxed with no allowance at all", frame?.sandbox === "", JSON.stringify(frame?.sandbox));
	check("the frame carries no event handler", frame?.onload === false, String(frame?.onload));
	const srcdoc = frame?.srcdoc ?? "";
	check("the frame's document is the sanitized archive", srcdoc.includes("<p>Safe archive</p>"), srcdoc.slice(0, 60));
	check("no script survives into the frame", !/<script/iu.test(srcdoc), "");
	check("no on-handler survives into the frame", !/\son[a-z]+\s*=/iu.test(srcdoc), "");
	check("no remote URL survives into the frame", !/evil\.example|remote\.example/iu.test(srcdoc), "");
	check("the frame carries its own Content-Security-Policy", srcdoc.includes("Content-Security-Policy") && srcdoc.includes("default-src 'none'"), "");
	check("the archived picture is inlined as data", srcdoc.includes("data:image/png;base64,"), "");
	check("the archived stylesheet is inlined", srcdoc.includes("<style>body{background:#fff}</style>"), "");
	check("the archive is not a folder listing", await notFolder(), "");

	// The rendered frame itself, when the sandbox still lets an out-of-process
	// evaluation in: the same facts read off the live document, not the attribute.
	const live = await Promise.race([
		(async () => {
			const children = (await preview.frames()).filter((candidate) => candidate !== preview.mainFrame() && candidate.url().startsWith("about:srcdoc"));
			if (children.length === 0) return null;
			return children[0]
				.evaluate(() => ({
					scripts: document.querySelectorAll("script").length,
					handlers: document.querySelectorAll("[onload],[onerror],[onclick]").length,
					text: document.body === null ? "" : document.body.textContent,
					html: document.documentElement.outerHTML,
				}))
				.catch(() => null);
		})(),
		sleep(4000).then(() => null),
	]);
	if (live === null) {
		info("frame DOM", "not readable from outside the sandbox (expected: the frame runs no script); the checks above read the frame's own srcdoc");
	} else {
		check("the rendered frame holds no script element", live.scripts === 0, String(live.scripts));
		check("the rendered frame holds no on-handler", live.handlers === 0, String(live.handlers));
		check("the rendered frame's text is the archived page", live.text.includes("Safe archive"), JSON.stringify(live.text.slice(0, 40)));
		check("the rendered frame names no remote host", !/evil\.example|remote\.example/u.test(live.html), "");
	}

	// The archived text must really paint: a blank frame leaves one flat colour.
	let paint = { dark: 0, width: 0, height: 0 };
	try {
		const framePixels = await preview.locator("iframe.ql-webarchive").screenshot();
		paint = await app.evaluate(({ nativeImage }, base64) => {
			const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
			const { width, height } = image.getSize();
			const bitmap = image.getBitmap();
			let dark = 0;
			for (let index = 0; index + 3 < bitmap.length; index += 4) {
				if (bitmap[index + 3] > 128 && 0.299 * bitmap[index] + 0.587 * bitmap[index + 1] + 0.114 * bitmap[index + 2] < 100) dark += 1;
			}
			return { dark, width, height };
		}, framePixels.toString("base64"));
	} catch (error) {
		info("frame screenshot", error instanceof Error ? error.message : String(error));
	}
	check("the archived page paints its text in the frame", paint.dark > 50, `${paint.dark} dark px in ${paint.width}x${paint.height}`);
	await shot("webarchive");

	// Nothing asked the archive's remote hosts for anything.
	const archiveRequests = pageRequests.slice(requestsBeforeArchive);
	const pageRemote = archiveRequests.filter((url) => /evil\.example|remote\.example/iu.test(url));
	const mainRemote = await app.evaluate(() => (globalThis.__qaRequests ?? []).filter((url) => /evil\.example|remote\.example/iu.test(url)));
	check("the page's network log holds no request to the archive's remote hosts", pageRemote.length === 0, JSON.stringify(pageRemote));
	check("the main process saw no request to the archive's remote hosts", mainRemote.length === 0, JSON.stringify(mainRemote));
	info("requests while the archive was open", `${archiveRequests.length} (${JSON.stringify(archiveRequests)})`);
	info("requests seen by session.webRequest", String((await app.evaluate(() => (globalThis.__qaRequests ?? []).length)) ?? 0));
	await close();

	// -----------------------------------------------------------------------
	// 3. The RTFD package: text plus an attachment list, never a folder listing.
	// -----------------------------------------------------------------------
	check("Notes.rtfd is listed as a file row, not a folder", await rowIsFile("Notes.rtfd"), "");
	await open("Notes.rtfd", stage("rtfd"));
	check("Space opens the RTFD viewer for the package directory", (await count(".ql-rtfd")) === 1, String(await count(".ql-rtfd")));
	check("the RTFD package is not shown as a folder listing", await notFolder(), "");
	const rtfdText = await text(".ql-rtfd__text");
	check("the viewer prints TXT.rtf's text", rtfdText.includes("Notes RTFD body") && rtfdText.includes("Second line"), JSON.stringify(rtfdText.slice(0, 60)));
	check("the viewer draws no attachment picture", (await count(".ql-rtfd img")) === 0, String(await count(".ql-rtfd img")));
	const attachments = await preview.locator(".ql-archive__items > div > span").allInnerTexts();
	check("the attachment list names photo.png only (the dotfile is skipped)", JSON.stringify(attachments.map((name) => name.trim())) === JSON.stringify(["photo.png"]), JSON.stringify(attachments));
	await shot("rtfd");
	await close();

	// -----------------------------------------------------------------------
	// 4. The iconset package.
	// -----------------------------------------------------------------------
	check("App.iconset is listed as a file row, not a folder", await rowIsFile("App.iconset"), "");
	await open("App.iconset", stage("iconset"));
	check("Space opens the iconset viewer for the package directory", (await count(".ql-iconset")) === 1, String(await count(".ql-iconset")));
	check("the iconset package is not shown as a folder listing", await notFolder(), "");
	check("both PNGs are drawn as icons", (await count(".ql-iconset__item")) === 2, String(await count(".ql-iconset__item")));
	const iconNames = await preview.locator(".ql-iconset__item figcaption").allInnerTexts();
	check("the icons are sorted by name and the non-PNG is ignored", JSON.stringify(iconNames.map((name) => name.trim())) === JSON.stringify(["icon_16x16.png", "icon_32x32.png"]), JSON.stringify(iconNames));
	const iconImages = await poll(
		() =>
			preview
				.locator(".ql-iconset__item img")
				.evaluateAll((images) => images.map((image) => ({ blob: image.src.startsWith("blob:"), width: image.naturalWidth, height: image.naturalHeight })))
				.catch(() => []),
		(images) => images.length === 2 && images.every((icon) => icon.blob && icon.width > 0 && icon.height > 0),
		10_000,
	);
	check("every icon is a decoded PNG image", iconImages.length === 2 && iconImages.every((icon) => icon.blob && icon.width > 0 && icon.height > 0), JSON.stringify(iconImages));
	await shot("iconset");
	await close();

	// -----------------------------------------------------------------------
	// 5. Text clippings: the plist form and the plain UTF-8 form.
	// -----------------------------------------------------------------------
	await open("Clip.textclipping", stage("textclipping"));
	check("Space opens the text-clipping viewer", (await count(".ql-textclipping")) === 1, String(await count(".ql-textclipping")));
	const clipped = (await text(".ql-textclipping")).trim();
	check("the plist clipping prints its text", clipped === "Clipped text", clipped);
	check("the clipping is not a folder listing", await notFolder(), "");
	await shot("textclipping-plist");
	await close();

	await open("Plain.textclipping", stage("textclipping"));
	const plainClipped = (await text(".ql-textclipping")).trim();
	check("a plain-text clipping prints its text too", plainClipped === "Plain clipped text", plainClipped);
	await shot("textclipping-plain");
	await close();

	// -----------------------------------------------------------------------
	// 6. The native-only formats: the info panel, with the OS rendering on macOS.
	// -----------------------------------------------------------------------
	const NATIVE_ONLY = ["Live.pvt", "Legacy.pict", "Localized.lpdf", "Settings.prefpane"];
	for (const name of NATIVE_ONLY) {
		const openedAt = Date.now();
		await open(name, showing(name));
		const openMs = Date.now() - openedAt;
		if (name === "Legacy.pict" && DARWIN) check("the info panel opens without waiting for the slow OS thumbnail", openMs < 4000, `${openMs}ms`);
		const panelName = (await text(".ql-other__name")).trim();
		check(`${name} opens as the info panel for that file`, panelName === name, panelName);
		check(`${name} is not shown as a folder listing`, await notFolder(), "");
		if (name === "Live.pvt" || name === "Localized.lpdf" || name === "Settings.prefpane") check(`${name} is listed as a file row, not a folder`, await rowIsFile(name), "");
		if (!DARWIN) {
			info(`${name} thumbnail`, "skipped: the OS rendering is macOS-only");
		} else {
			const drawn = await poll(
				() =>
					preview
						.locator("img.ql-native-thumbnail")
						.first()
						.evaluate((image) => ({ thumb: image.src.startsWith("autorag-thumb://"), width: image.naturalWidth, height: image.naturalHeight }))
						.catch(() => null),
				(value) => value !== null && value.thumb && value.width > 0 && value.height > 0,
				15_000,
			);
			check(`${name} shows the OS thumbnail the panel keeps for it`, drawn !== null, JSON.stringify(drawn));
		}
		await shot(`native-${name}`);
		await close();
	}
	if (DARWIN) {
		const tile = rowFor("Legacy.pict").locator("img.tile--image");
		const drawn = await poll(
			() =>
				tile
					.first()
					.evaluate((image) => image.src.startsWith("autorag-thumb://") && image.naturalWidth > 0)
					.catch(() => false),
			Boolean,
			20_000,
		);
		check("a native-only row draws the OS thumbnail tile, not a folder glyph", drawn === true && (await rowIsFile("Legacy.pict")), String(drawn));
	}
	await main.screenshot({ path: join(EVIDENCE, "listing.png") });

	// -----------------------------------------------------------------------
	// 7. Nothing external was opened.
	// -----------------------------------------------------------------------
	if (instruments.launchesGuarded) {
		const launches = await app.evaluate(() => globalThis.__qaLaunches ?? []);
		check("only the guarded internet-location Open action reached the OS opener", launches.length === 1 && launches[0]?.via === "openPath", JSON.stringify(launches));
	} else {
		info("external-launch guard", "not installed: the built app's shell module is read-only; the Open button was not pressed");
	}
	check("the preview window is still the Quick Look page", preview.url().includes("quick-look.html"), preview.url());

	// -----------------------------------------------------------------------
	// 8. The Interface language reaches the viewers, switched through Settings.
	// -----------------------------------------------------------------------
	await main.locator(".sidebar__item--settings").click();
	const languageSelect = main.locator('select[aria-label="App Language"]');
	await languageSelect.waitFor({ timeout: 20_000 });
	await languageSelect.selectOption("ko");
	const korean = await poll(() => main.locator('select[aria-label="앱 언어"]').count(), (value) => value === 1, 15_000);
	check("the real Settings UI switches the app to 한국어", korean === 1, String(korean));
	if (korean !== 1) info("korean settings", "the Settings UI never re-rendered in Korean; the panel checks below will report whatever came back");
	await main.keyboard.press(chord("w"));
	await poll(() => main.locator(".settings-panel").count(), (value) => value === 0, 10_000);

	await open("Example.webloc", stage("webloc"));
	const koreanOpen = (await text(".qlw__open")).trim();
	check("the reopened internet-location panel answers in Korean", koreanOpen.endsWith("열기"), koreanOpen);
	const koreanUrl = (await text(".ql-webloc__url")).trim();
	check("the Korean panel still shows the location", koreanUrl === LINK_URL, koreanUrl);
	await shot("webloc-ko");
	await close();

	await open("Empty.bin", showing("Empty.bin"));
	const koreanNote = (await text(".ql__note")).trim();
	check("the empty file's note is written in Korean", koreanNote === "빈 파일", koreanNote);
	await shot("native-empty-ko");
	await close();
} catch (error) {
	check("the lane ran to completion", false, error instanceof Error ? error.message : String(error));
} finally {
	await app.close().catch(() => undefined);
	rmSync(WORK, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; evidence in ${EVIDENCE}`);
process.exit(failed.length === 0 ? 0 : 1);
