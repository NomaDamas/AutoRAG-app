/**
 * Manual QA — Inspector Info panel metadata (real Electron).
 *
 * Builds a fixture folder with an EXIF JPEG and a text file, then checks on the
 * running app that selecting a file loads its rich metadata (path, created and
 * modified times, ownership, EXIF camera tags), that the Show more / Show less
 * toggle reveals and hides the long tail, that a non-image file shows no photo
 * section, and that a tall panel scrolls. Screenshots land in EVIDENCE.
 *
 * `bun run build` first, then
 * `bun scripts/manual-qa/run-qa-finder-info-metadata.mjs`
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExifJpeg } from "../../test/support/exif-fixture.ts";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-info-metadata");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const home = join(tmpdir(), "ulw-info-qa-home");
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const fixtureName = "ulw-info-qa";
const folder = join(home, "Documents", fixtureName);
mkdirSync(folder, { recursive: true });
const photo = join(folder, "photo.jpg");
await Bun.write(photo, buildExifJpeg());
await Bun.write(join(folder, "notes.txt"), "info panel qa\n");
mkdirSync(join(folder, "subfolder"), { recursive: true });
// A stable mtime so the "수정한 날짜" assertion does not depend on run time.
const FIXTURE_MTIME = new Date("2026-01-02T09:05:00Z");
for (const name of ["photo.jpg", "notes.txt"]) utimesSync(join(folder, name), FIXTURE_MTIME, FIXTURE_MTIME);

const userDataDir = mkdtempSync(join(tmpdir(), "ulw-info-data-"));

const results = [];
const check = (label, pass, detail = "") => {
	results.push({ label, pass, detail });
	if (!pass) console.log(`FAIL  ${label} ${detail}`);
};

/** Read the Info panel's sections and rows straight from the live DOM. */
const probe = (page) =>
	page.evaluate(() => {
		const body = document.querySelector(".inspector-body");
		if (body === null) return null;
		const sections = [...body.querySelectorAll(".info-section")].map((section) => ({
			title: section.querySelector(".section-title span")?.textContent ?? "",
			toggle: section.querySelector("button")?.textContent ?? null,
			rows: [...section.querySelectorAll("dl > div")].map((row) => ({
				label: row.querySelector("dt")?.textContent ?? "",
				value: row.querySelector("dd")?.textContent ?? "",
			})),
		}));
		return {
			sections,
			scrollHeight: body.scrollHeight,
			clientHeight: body.clientHeight,
			scrollTop: body.scrollTop,
			text: body.innerText,
		};
	});

const sectionRows = (state, title) => state.sections.find((section) => section.title === title)?.rows ?? [];
const valueOf = (rows, label) => rows.find((row) => row.label === label)?.value;
const hasLabel = (state, label) => state.sections.some((section) => section.rows.some((row) => row.label === label));

let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
	const page = await finderWindow(app, 30000);
	await page.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
	await page.waitForSelector(".toolbar-title", { timeout: 30000 });
	await page.waitForSelector(".sidebar__item", { timeout: 30000 });

	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const row = page.locator('[role="row"]').filter({ hasText: fixtureName }).first();
	await row.waitFor({ timeout: 30000 });
	await row.dblclick();
	await page.waitForFunction((name) => document.querySelector(".toolbar-title")?.textContent === name, fixtureName);
	await page.locator('[role="row"]').filter({ hasText: "photo.jpg" }).waitFor();
	await page.mouse.move(2, 2);

	// ---------------------------------------------------------- photo.jpg
	await page.locator('[role="row"]').filter({ hasText: "photo.jpg" }).first().click();
	await page.waitForFunction(() =>
		document.querySelector(".inspector-body")?.innerText.includes("생성한 날짜"),
	);
	await page.waitForFunction(() =>
		document.querySelector(".inspector-body")?.innerText.includes("카메라 모델"),
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	await page.screenshot({ path: join(EVIDENCE, "01-photo-expanded.png") });

	const expanded = await probe(page);
	const general = sectionRows(expanded, "일반 정보");
	const photo_ = sectionRows(expanded, "사진 정보");

	check("일반 정보 section is present", expanded.sections.some((section) => section.title === "일반 정보"));
	check("경로 row shows the absolute path", valueOf(general, "경로") === photo, String(valueOf(general, "경로")));
	check("위치 row shows the parent folder", valueOf(general, "위치") === folder, String(valueOf(general, "위치")));
	check("생성한 날짜 row is present", /^\d{4}-\d{2}-\d{2} /.test(String(valueOf(general, "생성한 날짜"))), String(valueOf(general, "생성한 날짜")));
	check("수정한 날짜 row is present", /^\d{4}-\d{2}-\d{2} /.test(String(valueOf(general, "수정한 날짜"))), String(valueOf(general, "수정한 날짜")));
	check("접근한 날짜 row is present when expanded", hasLabel(expanded, "접근한 날짜"));
	check("변경한 날짜 row is present when expanded", hasLabel(expanded, "변경한 날짜"));
	check("권한 row is present", /^[-dl][rwxsSt-]{9}$/.test(String(valueOf(general, "권한"))), String(valueOf(general, "권한")));
	check("소유자 row is present", (valueOf(general, "소유자") ?? "") !== "", String(valueOf(general, "소유자")));
	check("아이노드 row is present", /^\d+$/.test(String(valueOf(general, "아이노드"))), String(valueOf(general, "아이노드")));

	check("사진 정보 section is present for an EXIF image", photo_.length > 0);
	check("카메라 제조사 comes from EXIF", valueOf(photo_, "카메라 제조사") === "TestMake", String(valueOf(photo_, "카메라 제조사")));
	check("카메라 모델 comes from EXIF", valueOf(photo_, "카메라 모델") === "TestModel", String(valueOf(photo_, "카메라 모델")));
	check("렌즈 comes from EXIF", valueOf(photo_, "렌즈") === "TestLens 24-70", String(valueOf(photo_, "렌즈")));
	check("ISO comes from EXIF", valueOf(photo_, "ISO") === "400", String(valueOf(photo_, "ISO")));
	check("조리개 is formatted as f-number", valueOf(photo_, "조리개") === "f/2.8", String(valueOf(photo_, "조리개")));
	check("셔터 속도 is formatted as a reciprocal", valueOf(photo_, "셔터 속도") === "1/125초", String(valueOf(photo_, "셔터 속도")));
	check("초점 거리 is formatted in mm", valueOf(photo_, "초점 거리") === "35 mm", String(valueOf(photo_, "초점 거리")));
	check("이미지 크기 is formatted as width × height", valueOf(photo_, "이미지 크기") === "4000 × 3000", String(valueOf(photo_, "이미지 크기")));

	// ------------------------------------------------------- show less / more
	const toggleLabel = (state) =>
		state.sections.find((section) => section.title === "일반 정보")?.toggle ?? null;
	check("the toggle starts on 간략히 (fully expanded)", toggleLabel(expanded) === "간략히", String(toggleLabel(expanded)));

	await page.locator(".info-section button", { hasText: "간략히" }).click();
	await page.waitForFunction(() => document.querySelector(".inspector-body")?.innerText.includes("전체 정보"));
	await new Promise((resolve) => setTimeout(resolve, 200));
	const collapsed = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "02-photo-collapsed.png") });
	check("Show less keeps the core 경로 row", hasLabel(collapsed, "경로"));
	check("Show less keeps the core 생성한 날짜 row", hasLabel(collapsed, "생성한 날짜"));
	check("Show less hides the 접근한 날짜 row", !hasLabel(collapsed, "접근한 날짜"));
	check("Show less hides the 사진 정보 section", sectionRows(collapsed, "사진 정보").length === 0);
	check("the toggle flips to 전체 정보", toggleLabel(collapsed) === "전체 정보", String(toggleLabel(collapsed)));
	check("collapsing shortens the visible list", collapsed.text.length < expanded.text.length);

	await page.locator(".info-section button", { hasText: "전체 정보" }).click();
	await page.waitForFunction(() => document.querySelector(".inspector-body")?.innerText.includes("간략히"));
	await new Promise((resolve) => setTimeout(resolve, 200));
	const reexpanded = await probe(page);
	check("Show more restores the 사진 정보 section", sectionRows(reexpanded, "사진 정보").length > 0);
	check("Show more restores the 접근한 날짜 row", hasLabel(reexpanded, "접근한 날짜"));

	// -------------------------------------------------------------- scrolling
	await app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith("/index.html"));
		window.setMinimumSize(600, 420);
		window.setSize(1500, 560);
	});
	await page.waitForFunction(() => Math.abs(window.outerHeight - 560) <= 2, undefined, { timeout: 5000 });
	await new Promise((resolve) => setTimeout(resolve, 200));
	const tall = await probe(page);
	check("the panel overflows at a short window height", tall.scrollHeight > tall.clientHeight, `scroll=${tall.scrollHeight} client=${tall.clientHeight}`);
	const scrolled = await page.evaluate(() => {
		const body = document.querySelector(".inspector-body");
		body.scrollTop = body.scrollHeight;
		return body.scrollTop;
	});
	check("the panel body actually scrolls", scrolled > 0, String(scrolled));
	await page.screenshot({ path: join(EVIDENCE, "03-photo-scrolled.png") });
	await page.evaluate(() => {
		document.querySelector(".inspector-body").scrollTop = 0;
	});

	// ---------------------------------------------------------- notes.txt
	await page.locator('[role="row"]').filter({ hasText: "notes.txt" }).first().click();
	await page.waitForFunction(() =>
		document.querySelector(".inspector-body")?.innerText.includes("일반 정보"),
	);
	await page.waitForFunction((path) => {
		const rows = [...document.querySelectorAll(".inspector-body dl > div")];
		return rows.some((row) => row.querySelector("dt")?.textContent === "경로" && row.querySelector("dd")?.textContent === path);
	}, join(folder, "notes.txt"));
	await new Promise((resolve) => setTimeout(resolve, 300));
	const text = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "04-text-file.png") });
	check("a non-image file shows no 사진 정보 section", sectionRows(text, "사진 정보").length === 0);
	check("a non-image file has no 카메라 모델 row", !hasLabel(text, "카메라 모델"));
	check("a non-image file still shows 경로", hasLabel(text, "경로"));

	// ------------------------------------------------------------ subfolder
	await page.locator('[role="row"]').filter({ hasText: "subfolder" }).first().click();
	await page.waitForFunction(() =>
		document.querySelector(".inspector-body")?.innerText.includes("생성한 날짜"),
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const dir = await probe(page);
	await page.screenshot({ path: join(EVIDENCE, "05-folder.png") });
	check(
		"a folder shows its kind and no photo section",
		/Folder|폴더/.test(String(valueOf(sectionRows(dir, "일반 정보"), "종류"))) && sectionRows(dir, "사진 정보").length === 0,
		String(valueOf(sectionRows(dir, "일반 정보"), "종류")),
	);

	await Bun.write(
		join(EVIDENCE, "manifest.json"),
		`${JSON.stringify({ results, photo, folder }, null, 2)}\n`,
	);
} finally {
	await app?.close();
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed → ${EVIDENCE}`);
if (failed.length > 0 || results.length === 0) process.exitCode = 1;
