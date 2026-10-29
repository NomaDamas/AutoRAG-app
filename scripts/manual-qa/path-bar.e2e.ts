import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test("path bar completes folders with Tab and navigates clicked candidates", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autorag-path-bar-e2e-"));
	const home = join(dir, "home");
	const profile = join(dir, "profile");
	const evidence = "/tmp/autorag-path-bar-e2e";
	await Promise.all([
		mkdir(join(dir, "fixture", "Alpha"), { recursive: true }),
		mkdir(join(dir, "fixture", "Alpine"), { recursive: true }),
		mkdir(join(dir, "fixture", "Beta"), { recursive: true }),
		mkdir(join(home, ".autorag-home"), { recursive: true }),
		mkdir(profile, { recursive: true }),
		mkdir(evidence, { recursive: true }),
	]);
	await writeFile(
		join(dir, "fixture", "Alpha-notes.txt"),
		"not a folder candidate\n",
	);
	const fixture = join(dir, "fixture");
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
		const editPath = async () => {
			await main.keyboard.press(
				process.platform === "darwin" ? "Meta+L" : "Control+L",
			);
			await expect(main.locator(".path-edit")).toBeFocused();
		};
		const options = main.getByRole("option");

		await editPath();
		await main.keyboard.type(join(fixture, "al"));
		await expect(options).toHaveCount(2);
		await expect(options.nth(0)).toHaveText("Alpha");
		await expect(options.nth(1)).toHaveText("Alpine");
		await expect(main.locator("[data-path-ghost]")).toHaveText("pha");
		await main.screenshot({ path: join(evidence, "candidates.png") });

		await main.keyboard.press("ArrowDown");
		await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
		await expect(main.locator("[data-path-ghost]")).toHaveText("pine");
		await main.keyboard.press("Tab");
		await expect(main.locator(".path-edit")).toHaveValue(
			join(fixture, "Alpine"),
		);
		await expect(main.locator(".toolbar-title")).not.toHaveText("Alpine");
		await main.keyboard.press("Enter");
		await expect(main.locator(".toolbar-title")).toHaveText("Alpine");
		await expect(main.locator(".path-edit")).toHaveCount(0);

		await editPath();
		await main.keyboard.type(join(fixture, "Be"));
		await expect(options).toHaveCount(1);
		await options.first().click();
		await expect(main.locator(".toolbar-title")).toHaveText("Beta");
		await expect(main.locator(".path-edit")).toHaveCount(0);
		await main.screenshot({ path: join(evidence, "clicked-candidate.png") });
	} finally {
		await app.close();
		await rm(dir, { recursive: true, force: true });
	}
});
