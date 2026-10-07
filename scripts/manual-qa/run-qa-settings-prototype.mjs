import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTOTYPE = join(ROOT, "docs/prototypes/settings/index.html");
const EVIDENCE = join(ROOT, ".omo/evidence/settings-prototype");
mkdirSync(EVIDENCE, { recursive: true });
for (const entry of ["light.png", "dark.png", "narrow.png"]) {
  try { rmSync(join(EVIDENCE, entry)); } catch {}
}

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(error.message));
try {
  await page.goto(`file://${PROTOTYPE}`);
  await page.waitForSelector(".settings-shell");
  check("prototype opens", await page.locator("h1").count() === 1);
  check("default page is General", (await page.locator("h1").innerText()) === "일반");

  const navIds = await page.locator("[data-nav]").evaluateAll((items) => [...new Set(items.map((item) => item.dataset.nav))]);
  const openPage = async (id) => {
    const expected = { general: "일반", ai: "AI 모델", quality: "검색 품질", web: "웹 검색", scope: "검색 범위", reading: "문서 읽기", duplicates: "중복 파일 정리", apps: "연결된 앱", advanced: "고급 설정" }[id];
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.locator(`[data-nav="${id}"]`).first().click();
      await page.waitForTimeout(60);
      const heading = await page.locator("h1").innerText();
      if (expected === undefined || heading === expected) return;
    }
    throw new Error(`navigation to ${id} did not settle on its page`);
  };
  for (const id of navIds.filter((item) => !item.startsWith("source/"))) {
    await openPage(id);
    check(`navigation renders ${id}`, await page.locator("h1").count() === 1, await page.locator("h1").innerText());
    const layout = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, labels: [...document.querySelectorAll(".row-label")].map((el) => el.getBoundingClientRect().width) }));
    check(`${id} has no horizontal overflow`, layout.scroll <= layout.client + 1, `${layout.scroll}/${layout.client}`);
    check(`${id} labels are not crushed`, layout.labels.every((width) => width >= 120), JSON.stringify(layout.labels));
  }

  const alignment = await page.evaluate(() => {
    const center = (el) => { const box = el.getBoundingClientRect(); return (box.top + box.bottom) / 2; };
    return [...document.querySelectorAll(".nav-item")].map((item) => {
      const icon = item.querySelector("svg.icon");
      const label = item.querySelector(".nav-label");
      if (icon === null || label === null) return 0;
      return Math.abs(center(icon) - center(label));
    });
  });
  check("sidebar icons share the label's vertical center", alignment.every((delta) => delta <= 1), `max delta ${Math.max(...alignment).toFixed(2)}px`);

  await page.locator('[data-nav="ai"]').first().click();
  await page.locator('[data-action="combo"]').click();
  await page.locator("#model-input").fill("GPT");
  check("model picker filters", (await page.locator("#model-list").innerText()).includes("GPT-5"));
  await page.locator('#model-list [data-model="openai/gpt-5"]').click();
  check("model selection saves", (await page.locator('[data-action="combo"]').innerText()).includes("GPT-5"));
  await page.locator('[data-nav="quality"]').first().click();
  await page.locator('[data-select="embed"]').selectOption("가벼움");
  check("embedding change asks for confirmation", await page.getByRole("dialog").count() === 1 && (await page.getByRole("dialog").innerText()).includes("다시 분석"));
  await page.locator('.modal-backdrop').click({ position: { x: 4, y: 4 } });
  await page.locator('[data-nav="apps"]').first().click();
  await page.locator('[data-add="notion"]').click();
  check("add connection modal opens", await page.getByRole("dialog").count() === 1 && (await page.getByRole("dialog").innerText()).includes("Notion"));
  await page.locator('[data-connect="notion"]').click();
  check("new connection detail opens", (await page.locator("h1").innerText()).includes("Notion"));
  await page.locator('[data-nav="apps"]').first().click();
  await page.locator("#settings-search").fill("OCR");
  check("settings search finds OCR", (await page.locator("#nav").innerText()).includes("문서 읽기"));
  await page.locator('[data-nav="reading"]').first().click();
  check("advanced disclosure exists", await page.locator("details").count() > 0);
  await page.locator("#notes-toggle").click();
  check("change notes toggle works", await page.locator(".notes").count() === 1);
  await page.locator("#theme-toggle").click();
  check("dark theme toggles", await page.locator("html[data-appearance='dark']").count() === 1);
  await page.screenshot({ path: join(EVIDENCE, "dark.png"), fullPage: true });
  await page.locator("#theme-toggle").click();
  await page.screenshot({ path: join(EVIDENCE, "light.png"), fullPage: true });
  await page.setViewportSize({ width: 760, height: 700 });
  await page.reload();
  await page.waitForSelector(".settings-shell");
  const narrow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  check("narrow viewport has no horizontal overflow", narrow.scroll <= narrow.client + 1, `${narrow.scroll}/${narrow.client}`);
  await page.screenshot({ path: join(EVIDENCE, "narrow.png"), fullPage: true });
  check("no browser console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`FAILED ${failures.length} checks: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`PASS settings prototype QA — evidence in ${EVIDENCE}`);
}
