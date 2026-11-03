import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

/**
 * The inspector is a real right sidebar: a full-height column with its own head,
 * so the toolbar stops at its left edge, and it hides and shows like the left
 * sidebar (a button in its head hides it, a button at the toolbar's far end
 * brings it back). The view, Sort, and Group controls follow the toolbar's edge.
 */
test("the inspector is a full-height right sidebar that hides and shows like the left one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autorag-right-sidebar-e2e-"));
	const home = join(dir, "home");
	const profile = join(dir, "profile");
	const fixture = join(dir, "fixture");
	const evidence = "/tmp/autorag-right-sidebar-e2e";
	await Promise.all([
		mkdir(join(home, ".autorag-home"), { recursive: true }),
		mkdir(profile, { recursive: true }),
		mkdir(fixture, { recursive: true }),
		mkdir(evidence, { recursive: true }),
	]);
	await writeFile(join(fixture, "notes.md"), "# notes\n");
	const app = await electron.launch({
		args: [".", `--user-data-dir=${profile}`],
		cwd: process.cwd(),
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			AUTORAG_HOME: join(home, ".autorag-home"),
			AUTORAG_CONFIG: join(home, ".autorag-home", "config.json"),
			AUTORAG_QA_ROOT: fixture,
			AUTORAG_SKIP_DUPEY_CHECK: "1",
			AUTORAG_SKIP_ONBOARDING: "1",
		},
	});
	try {
		const main =
			app.windows().find((page) => page.url().endsWith("/index.html")) ??
			(await app.waitForEvent("window", {
				predicate: (page) => page.url().endsWith("/index.html"),
				timeout: 30_000,
			}));
		await main.locator(".toolbar-title").waitFor({ timeout: 30_000 });
		await main.setViewportSize({ width: 1400, height: 860 });
		const hide = main.getByRole("button", { name: "Hide inspector", exact: true });
		const show = main.locator('.toolbar [aria-label="Show inspector"]');
		// The column animates its width; read geometry once it has settled.
		const settled = async (page: Page) => {
			let last = "";
			for (let i = 0; i < 40; i += 1) {
				const now = JSON.stringify(await geometry(page));
				if (now === last) return JSON.parse(now) as Geometry;
				last = now;
				await page.waitForTimeout(60);
			}
			return JSON.parse(last) as Geometry;
		};

		// 1. Shown: the column runs from the window top, and the toolbar ends at its edge.
		// Share appears once the OS share probe answers (macOS only); measure after it so the cluster is final.
		if (process.platform === "darwin") await main.locator('.toolbar [aria-label="Share"]').waitFor({ timeout: 10_000 });
		await expect(hide).toBeVisible();
		await expect(show).toHaveCount(0);
		let g = await settled(main);
		expect(g.column.top).toBe(0);
		expect(g.column.right).toBe(g.window);
		expect(g.column.width).toBeGreaterThanOrEqual(300);
		expect(Math.abs(g.toolbar.right - g.column.left)).toBeLessThanOrEqual(1);
		expect(g.head.height).toBe(g.toolbar.height);
		expect(g.hide.left).toBeGreaterThanOrEqual(g.column.left);
		expect(g.group.right).toBeLessThanOrEqual(g.column.left);
		const shownGroupRight = g.group.right;
		await main.screenshot({ path: join(evidence, "01-shown.png") });

		// 2. Hidden: the column collapses, the toolbar spans the window, and the controls slide right.
		await hide.click();
		await expect(show).toBeVisible();
		await expect(hide).toHaveCount(0);
		g = await settled(main);
		expect(g.column.width).toBe(0);
		expect(g.toolbar.right).toBe(g.window);
		expect(g.group.right).toBeGreaterThan(shownGroupRight + 200);
		expect(g.lastButton).toBe("Show inspector");
		await main.screenshot({ path: join(evidence, "02-hidden.png") });

		// 3. The choice survives a reload.
		await main.reload();
		await main.locator(".toolbar-title").waitFor({ timeout: 30_000 });
		await expect(show).toBeVisible();

		// 4. Shown again from the toolbar.
		await show.click();
		await expect(hide).toBeVisible();
		g = await settled(main);
		expect(Math.abs(g.toolbar.right - g.column.left)).toBeLessThanOrEqual(1);
		expect(g.group.right).toBe(shownGroupRight);
		await main.screenshot({ path: join(evidence, "03-shown-again.png") });
	} finally {
		await app.close();
		await rm(dir, { recursive: true, force: true });
	}
});

interface Box {
	readonly top: number;
	readonly left: number;
	readonly right: number;
	readonly width: number;
	readonly height: number;
}

interface Geometry {
	readonly window: number;
	readonly toolbar: Box;
	readonly column: Box;
	readonly head: Box;
	readonly hide: Box;
	readonly group: Box;
	readonly lastButton: string | null;
}

function geometry(page: Page): Promise<Geometry> {
	return page.evaluate(() => {
		const box = (selector: string, cell = false): Box => {
			const found = document.querySelector(selector);
			const rect = (cell ? found?.parentElement : found)?.getBoundingClientRect();
			return rect === undefined
				? { top: -1, left: -1, right: -1, width: -1, height: -1 }
				: { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
		};
		const buttons = [...document.querySelectorAll(".toolbar button")];
		return {
			window: document.documentElement.clientWidth,
			toolbar: box(".toolbar"),
			// The window grid's cell clips the column (which keeps its width) while it slides shut.
			column: box(".inspector-column", true),
			head: box(".inspector-head"),
			hide: box('.inspector-head [aria-label="Hide inspector"]'),
			group: box('.toolbar__control[aria-label="Group"]'),
			lastButton: buttons.at(-1)?.getAttribute("aria-label") ?? null,
		};
	});
}
