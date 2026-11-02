import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

/** The first-run onboarding renderer: it and the Finder both load /index.html, so the preload's pending flag tells them apart. */
async function onboardingPage(app: ElectronApplication): Promise<Page> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		for (const page of app.windows().filter((candidate) => candidate.url().endsWith("/index.html"))) {
			const pending = await page.evaluate(() => Reflect.get(Reflect.get(window, "autorag") ?? {}, "onboarding")?.pending === true).catch(() => false);
			if (pending) return page;
		}
		if (Date.now() >= deadline) throw new Error("Onboarding window did not open");
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
		const page = await onboardingPage(app);
		// Force the not-yet-granted state so the permission button is present on every host.
		// The real openFullDiskAccess handler still runs and opens macOS System Settings.
		await app.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler("onboarding:permissions");
			ipcMain.handle("onboarding:permissions", () => ({
				platform: "darwin",
				fullDiskAccess: false,
				launchAtLogin: true,
				notificationsSupported: true,
			}));
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
		await page.locator(".onb .screen").waitFor({ timeout: 30_000 });
		await page.locator(".onb .footer .footer-actions button:last-child").click();
		await expect(page.locator(".onb .permission-list")).toBeVisible();
		await expect(page.locator(".onb .permissions-why")).toHaveCount(0);
		await page.screenshot({ path: join(evidence, "permissions.png") });

		await page.locator(".onb .permission-list button").first().click();
		await expect.poll(() => app.evaluate(() => Number(Reflect.get(globalThis, "__qaOpenFullDiskAccess") ?? 0))).toBe(1);
		await expect(page.locator(".onb .modal")).toHaveCount(0);
		await expect(page.locator(".onb .scrim")).toHaveAttribute("hidden", "");
		await page.screenshot({ path: join(evidence, "after-open-settings.png") });
	} finally {
		await app.close();
		await rm(dir, { recursive: true, force: true });
	}
});
