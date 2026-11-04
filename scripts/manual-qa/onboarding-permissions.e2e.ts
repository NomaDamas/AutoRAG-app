import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/** The first-run renderer: the Finder window itself carries the pending flag on a first run, and hosts the overlay. */
async function firstRunPage(app: ElectronApplication): Promise<Page> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		for (const page of app.windows().filter((candidate) => candidate.url().endsWith("/index.html"))) {
			const pending = await page.evaluate(() => Reflect.get(Reflect.get(window, "autorag") ?? {}, "onboarding")?.pending === true).catch(() => false);
			if (pending) return page;
		}
		if (Date.now() >= deadline) throw new Error("The first-run window did not open");
		await sleep(100);
	}
}

test("Full Disk Access opens macOS System Settings directly without an explanation modal", async () => {
	test.skip(process.platform !== "darwin", "Full Disk Access onboarding is macOS-only");
	const dir = await mkdtemp(join(tmpdir(), "autorag-onboarding-permissions-e2e-"));
	const home = join(dir, "home");
	const profile = join(dir, "profile");
	const evidence = "/tmp/autorag-onboarding-permissions-e2e";
	await Promise.all([
		mkdir(join(home, ".autorag-home"), { recursive: true }),
		mkdir(profile, { recursive: true }),
		mkdir(evidence, { recursive: true }),
	]);
	const app = await electron.launch({
		args: [".", `--user-data-dir=${profile}`],
		cwd: process.cwd(),
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			AUTORAG_HOME: join(home, ".autorag-home"),
			AUTORAG_CONFIG: join(home, ".autorag-home", "config.json"),
			AUTORAG_SKIP_DUPEY_CHECK: "1",
		},
	});
	try {
		// The renderer only exists once the main process registered its handlers.
		const page = await firstRunPage(app);
		// Force the not-yet-granted state so the permission card is present on every host. The real
		// openFullDiskAccess handler still runs and opens macOS System Settings; the wrapper counts the calls.
		await app.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler("onboarding:permissions");
			ipcMain.handle("onboarding:permissions", () => ({ platform: "darwin", fullDiskAccess: false }));
			// Electron keeps its invoke handlers in this private map; wrap the real one instead of replacing it.
			const handlers: Map<string, (event: unknown) => unknown> = Reflect.get(ipcMain, "_invokeHandlers");
			const open = handlers.get("onboarding:openFullDiskAccess");
			if (open === undefined) throw new Error("onboarding:openFullDiskAccess is not registered");
			ipcMain.removeHandler("onboarding:openFullDiskAccess");
			ipcMain.handle("onboarding:openFullDiskAccess", (event) => {
				Reflect.set(globalThis, "__qaOpenFullDiskAccess", Number(Reflect.get(globalThis, "__qaOpenFullDiskAccess") ?? 0) + 1);
				return open(event);
			});
		});
		await page.reload();
		await page.locator('.fr-root[data-screen="permission"]').waitFor({ timeout: 30_000 });
		await expect(page.locator(".fr-permission")).toBeVisible();
		// No explanation modal sits in front of the card: the button opens System Settings itself.
		await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		await page.screenshot({ path: join(evidence, "permissions.png") });

		await page.locator('[data-action="open-fda"]').click();
		await expect.poll(() => app.evaluate(() => Number(Reflect.get(globalThis, "__qaOpenFullDiskAccess") ?? 0))).toBe(1);
		await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		await page.screenshot({ path: join(evidence, "after-open-settings.png") });
	} finally {
		await app.close();
		await rm(dir, { recursive: true, force: true });
	}
});
