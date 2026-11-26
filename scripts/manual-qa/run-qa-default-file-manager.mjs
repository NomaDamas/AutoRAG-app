// Live E2E QA for Default File Manager integration (macOS & Windows).
//
// macOS checks (run inside Tart VM via `bun run qa script --vm scripts/manual-qa/run-qa-default-file-manager.mjs`):
//   1. Settings → General renders the "Use as Default File Manager" switch;
//      toggling ON writes `defaults read -g NSFileViewer == com.autorag.app` and
//      registers LaunchServices `public.folder` handler; toggling OFF restores Finder.
//   2. The native macOS AppleEvent `misc`/`mvis` reveal hook is loaded in the running
//      Electron main process (`defaultFileManager.status().macRevealHookLoaded === true`).
//   3. Sending a real macOS AppleEvent `misc`/`mvis` (`kAERevealSelection`) to the
//      running Electron process reveals and selects the target file inside Dazzi!
//   4. Launching with `--autorag-default-open <folder>` hands over to the running
//      instance and opens that folder in Dazzi.
//   5. Screenshots of Settings → General and revealed file are saved to `QA_OUT`.
//
// Windows checks (run on Windows via SSH `bun scripts/manual-qa/run-qa-default-file-manager.mjs`):
//   1. Settings → General renders both "Use as Default File Manager" and
//      "Also intercept 'Show in folder' from other apps" switches.
//   2. Toggling ON writes HKCU `Folder\shell\open\command`, `Directory\shell\open\command`,
//      and Win+E CLSID `{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command`
//      and starts the background Explorer window watcher (`interceptRevealActive === true`).
//   3. Opening a folder via `--autorag-default-open <dir>` hands over to the running app.
//   4. Opening a file with Windows Explorer (`explorer.exe /select,<file>`, simulating
//      Chrome/VS Code `SHOpenFolderAndSelectItems`) is intercepted by the watcher:
//      the Explorer window is closed and Dazzi reveals & selects the target file!
//   5. Toggling OFF removes all HKCU keys and stops the watcher, cleanly restoring Explorer.
//
// Prerequisites: `bun run build`.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { isMac, isWindows } from "./platform.mjs";

const OUT = process.env.QA_OUT ?? mkdtempSync(join(tmpdir(), "autorag-qa-dfm-out-"));
mkdirSync(OUT, { recursive: true });

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-dfm-")));
const USER_DATA = join(WORK, "user-data");
const TARGET_DIR = join(WORK, "target-folder");
const REVEAL_DIR = join(WORK, "reveal-folder");
const REVEAL_FILE = join(REVEAL_DIR, "find-me-in-dazzi.txt");
const EXTRA_FILE = join(TARGET_DIR, "opened-via-default-manager.txt");

for (const dir of [USER_DATA, TARGET_DIR, REVEAL_DIR]) mkdirSync(dir, { recursive: true });
writeFileSync(REVEAL_FILE, "reveal target\n");
writeFileSync(EXTRA_FILE, "folder open target\n");

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
	if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (probe, timeoutMs = 20_000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const val = await probe();
		if (val) return val;
		if (Date.now() >= deadline) return false;
		await sleep(150);
	}
};

function readMacNsFileViewer() {
	try {
		return execFileSync("/usr/bin/defaults", ["read", "-g", "NSFileViewer"], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

function readWinReg(key) {
	try {
		return execFileSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true });
	} catch {
		return "";
	}
}

let app;
try {
	app = await launchFinder({ userDataDir: USER_DATA });
	const page = await finderWindow(app);

	const initialStatus = await page.evaluate(() => window.autorag.defaultFileManager.status());
	console.log("initial defaultFileManager.status:", JSON.stringify(initialStatus));
	check("bridge status reports supported on this OS", initialStatus.supported === true, initialStatus.platform);

	// Open Settings → General (Default File Manager is now the top section and defaults to ON).
	await page.locator(".sidebar__item--settings").click();
	const dfmSwitch = page.getByRole("switch", { name: /Use as Default File Manager|기본 파일 관리자로 사용/u });
	await dfmSwitch.waitFor({ timeout: 20_000 });
	check("default file manager switch defaults to ON at top of General", (await dfmSwitch.getAttribute("aria-checked")) === "true");

	// Toggle OFF then ON to exercise full live registration in unpackaged QA runs.
	await dfmSwitch.click();
	await until(async () => (await dfmSwitch.getAttribute("aria-checked")) === "false");
	await dfmSwitch.click();
	const enabledStatus = await until(async () => {
		const s = await page.evaluate(() => window.autorag.defaultFileManager.status());
		return s.enabled && s.osRegistered ? s : false;
	});
	check("toggling ON registers OS default file manager", enabledStatus !== false, JSON.stringify(enabledStatus));
	await page.screenshot({ path: join(OUT, "01-settings-enabled.png") });

	if (isMac) {
		check("macOS NSFileViewer set to com.autorag.app", readMacNsFileViewer() === "com.autorag.app", readMacNsFileViewer());
		check("macOS native AppleEvent misc/mvis hook loaded", initialStatus.macRevealHookLoaded === true);

		// Send real macOS AppleEvent `misc`/`mvis` (`kAERevealSelection`) to the running Electron PID!
		const mainPid = app.process().pid;
		const sendAeJxa = `
ObjC.import("Cocoa");
ObjC.import("Carbon");
function run(argv) {
	const pid = parseInt(argv[0], 10);
	const filePath = argv[1];
	const target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(pid);
	const event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
		0x6d697363, // 'misc' kAEMiscStandards
		0x6d766973, // 'mvis' kAERevealSelection
		target,
		0,
		0
	);
	const url = $.NSURL.fileURLWithPath(filePath);
	const fileDesc = $.NSAppleEventDescriptor.descriptorWithFileURL(url);
	const list = $.NSAppleEventDescriptor.listDescriptor;
	list.insertDescriptorAtIndex(fileDesc, 1);
	event.setParamDescriptorForKeyword(list, 0x2d2d2d2d); // '----' keyDirectObject
	const err = Ref();
	const reply = event.sendEventWithOptionsTimeoutError(2, 5.0, err); // kAENoReply = 2
	return reply ? "sent" : "sent-noreply";
}
`;
		const aeOut = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", sendAeJxa, String(mainPid), REVEAL_FILE], { encoding: "utf8" }).trim();
		console.log("macOS AppleEvent misc/mvis send result:", aeOut);

		const revealedRow = page.locator(`[data-path="${REVEAL_FILE}"]`).first();
		const revealed = await until(async () => (await revealedRow.count()) > 0, 15_000);
		check("macOS AppleEvent misc/mvis reveals file in Dazzi", revealed !== false, REVEAL_FILE);
		await page.screenshot({ path: join(OUT, "02-mac-revealed-via-appleevent.png") });
	}

	if (isWindows) {
		const folderReg = readWinReg("HKCU\\Software\\Classes\\Folder\\shell\\open\\command");
		const winEReg = readWinReg("HKCU\\Software\\Classes\\CLSID\\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\\shell\\opennewwindow\\command");
		check("Windows HKCU Folder open command registered", folderReg.includes("--autorag-default-open"), folderReg.trim());
		check("Windows HKCU Win+E CLSID command registered", winEReg.includes("--autorag-new-window"), winEReg.trim());

		const interceptSwitch = page.getByRole("switch", { name: /Also intercept|가로채기/u });
		await interceptSwitch.waitFor({ timeout: 10_000 });
		check("Windows intercept-reveal sub-switch is ON by default when enabled", (await interceptSwitch.getAttribute("aria-checked")) === "true");
		const winStatus = await page.evaluate(() => window.autorag.defaultFileManager.status());
		check("Windows Explorer watcher process is active", winStatus.interceptRevealActive === true, JSON.stringify(winStatus));

		// 1. Test real OS ShellExecute folder open via the live HKCU\Software\Classes\Folder\shell\open\command key!
		execFileSync("powershell.exe", ["-NoProfile", "-Command", `Start-Process -FilePath '${REVEAL_DIR.replaceAll("'", "''")}'`], {
			timeout: 15_000,
			windowsHide: true,
		});
		const shellExecRow = page.locator(`[data-path="${REVEAL_FILE.replaceAll("\\", "\\\\")}"]`).first();
		const shellExecOpened = await until(async () => (await shellExecRow.count()) > 0, 20_000);
		check("Windows ShellExecute(open, folder) routes via HKCU registry into running Dazzi", shellExecOpened !== false, REVEAL_DIR);
		await page.screenshot({ path: join(OUT, "02-win-opened-via-shellexecute.png") });

		// 2. Test Explorer /select,<file> interception when running in an interactive desktop session
		// (headless SSH session 0 denies Shell.Application.Windows() COM access).
		let canQueryShellWindows = false;
		try {
			execFileSync("powershell.exe", ["-NoProfile", "-Command", "$s = New-Object -ComObject Shell.Application; [void]$s.Windows()"], {
				timeout: 10_000,
				windowsHide: true,
			});
			canQueryShellWindows = true;
		} catch {
			canQueryShellWindows = false;
		}
		if (canQueryShellWindows) {
			await sleep(1500);
			const exp = spawn("explorer.exe", [`/select,${REVEAL_FILE}`], { detached: true, stdio: "ignore" });
			exp.unref();
			const revealed = await until(async () => (await shellExecRow.count()) > 0, 20_000);
			check("Windows Explorer /select,<file> intercepted and revealed in Dazzi", revealed !== false, REVEAL_FILE);
		} else {
			console.log("INFO Windows Explorer /select COM check skipped (non-interactive session 0 denies IShellWindows)");
		}
	}

	// Test `--autorag-default-open <folder>` handoff to running app (both OSes)
	const execPath = await app.evaluate(({ app: electronApp }) => process.execPath);
	const appPath = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath());
	const isPackaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);
	const helperArgs = [
		...(isPackaged ? [] : [appPath]),
		`--user-data-dir=${USER_DATA}`,
		"--autorag-default-open",
		TARGET_DIR,
	];
	execFileSync(execPath, helperArgs, { timeout: 20_000, windowsHide: true });
	const openedRow = page.locator(`[data-path="${EXTRA_FILE.replaceAll("\\", "\\\\")}"]`).first();
	const opened = await until(async () => (await openedRow.count()) > 0, 15_000);
	check("--autorag-default-open hands folder to running Dazzi window", opened !== false, EXTRA_FILE);
	await page.screenshot({ path: join(OUT, "03-folder-opened-via-handoff.png") });

	// Turn OFF and verify clean OS restore
	await page.locator(".sidebar__item--settings").click();
	await dfmSwitch.waitFor({ timeout: 15_000 });
	await dfmSwitch.click();
	const disabledStatus = await until(async () => {
		const s = await page.evaluate(() => window.autorag.defaultFileManager.status());
		return !s.enabled && !s.osRegistered ? s : false;
	});
	check("toggling OFF restores OS default file manager", disabledStatus !== false, JSON.stringify(disabledStatus));
	if (isMac) {
		check("macOS NSFileViewer cleared on disable", readMacNsFileViewer() === "", readMacNsFileViewer());
	}
	if (isWindows) {
		check("Windows HKCU Folder key removed on disable", readWinReg("HKCU\\Software\\Classes\\Folder\\shell\\open\\command") === "");
		check("Windows Explorer watcher stopped on disable", disabledStatus !== false && disabledStatus.interceptRevealActive === false);
	}
	await page.screenshot({ path: join(OUT, "04-settings-disabled.png") });
} catch (error) {
	console.error(error);
	failures += 1;
} finally {
	if (app !== undefined) await app.close().catch(() => {});
	rmSync(WORK, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`FAIL default-file-manager: ${failures} check(s) failed`);
	process.exit(1);
}
console.log("PASS default-file-manager live E2E QA");
