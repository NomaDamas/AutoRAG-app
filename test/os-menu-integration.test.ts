import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOsMenuIntegration,
	macServiceInfoPlist,
	macServiceScript,
	menuLabels,
	shellQuote,
	winInstallCommands,
	winUninstallCommands,
	winVerbCommand,
	workflowDirName,
} from "../src/main/os-menu-integration";
import { parseOsRequestArgv } from "../src/shared/os-request-contract";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "os-menu-"));
	dirs.push(dir);
	return dir;
}

const LABELS = { ask: "Ask AutoRAG", reveal: "Show in AutoRAG" } as const;
// The workflow runs under zsh and Automator's plist tooling; both exist only on macOS.
const onMac = describe.skipIf(process.platform !== "darwin");

onMac("macOS service script", () => {
	it("passes every selected item, spaces and quotes included, as one argv entry the app parses back", async () => {
		const dir = await tempDir();
		// The script backgrounds the launch, so the stand-in executable reports through a FIFO:
		// reading it blocks until the launch has really happened.
		const report = join(dir, "argv.fifo");
		execFileSync("/usr/bin/mkfifo", [report]);
		const fake = join(dir, "fake app's bin");
		await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(report)}\n`);
		await chmod(fake, 0o755);
		const items = ["/Users/x/My Docs/it's \"quoted\" $HOME `x`.pdf", "/Users/x/한글 폴더"];
		execFileSync("/bin/zsh", ["-c", macServiceScript(fake, ["/app dir"], "ask"), "workflow", ...items]);
		const argv = (await readFile(report, "utf8")).trimEnd().split("\n");
		expect(argv[0]).toBe("/app dir");
		expect(parseOsRequestArgv(argv)).toEqual({ action: "ask", paths: items });
	});
});

describe("shellQuote", () => {
	it("quotes a single quote so no value can end the quoted string", () => {
		expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
	});
});

describe("macOS install", () => {
	function menuFor(home: string, runs: string[][]) {
		return createOsMenuIntegration({
			platform: "darwin",
			homeDir: home,
			execPath: "/Applications/AutoRAG.app/Contents/MacOS/AutoRAG",
			appArgs: [],
			run: async (command, args) => void runs.push([command, ...args]),
		});
	}

	it.skipIf(process.platform !== "darwin")("writes one valid Finder-only service per action, replaces them on a language change, and removes only its own", async () => {
		const home = await tempDir();
		const services = join(home, "Library", "Services");
		await mkdir(join(services, "Someone Else.workflow", "Contents"), { recursive: true });
		const runs: string[][] = [];
		const menu = menuFor(home, runs);
		await menu.install(LABELS);
		expect((await readdir(services)).sort()).toEqual(["Ask AutoRAG.workflow", "Show in AutoRAG.workflow", "Someone Else.workflow"]);
		for (const name of ["Ask AutoRAG.workflow", "Show in AutoRAG.workflow"]) {
			for (const file of ["Info.plist", "document.wflow"]) {
				execFileSync("/usr/bin/plutil", ["-lint", join(services, name, "Contents", file)]);
			}
		}
		expect(runs).toEqual([["/System/Library/CoreServices/pbs", "-update"]]);

		const korean = menuLabels("ko");
		await menu.install(korean);
		expect((await readdir(services)).sort()).toEqual([`${korean.ask}.workflow`, `${korean.reveal}.workflow`, "Someone Else.workflow"].sort());

		await menu.uninstall();
		expect(await readdir(services)).toEqual(["Someone Else.workflow"]);
	});

	it("limits the service to Finder and escapes the caption", () => {
		const plist = macServiceInfoPlist("ask", 'A & <B> "C"');
		expect(plist).toContain("<string>com.apple.finder</string>");
		expect(plist).toContain("A &amp; &lt;B&gt; &quot;C&quot;");
		expect(plist).toContain("com.autorag.app.service.ask");
	});

	it("never lets a caption escape the Services directory", () => {
		expect(workflowDirName("../../evil")).toBe(".. .. evil.workflow");
		expect(workflowDirName("a:b/c")).toBe("a b c.workflow");
		expect(workflowDirName("  ")).toBe("AutoRAG.workflow");
	});
});

describe("Windows commands", () => {
	const deps = { execPath: "C:\\Program Files\\AutoRAG\\AutoRAG.exe", appArgs: [] as string[] };

	it("registers both verbs for files and folders under HKCU, so no elevation is needed", () => {
		const calls = winInstallCommands(deps, LABELS);
		const keys = calls.map((call) => call[1]);
		expect(keys.every((key) => key?.startsWith("HKCU\\Software\\Classes\\"))).toBe(true);
		expect(keys).toContain("HKCU\\Software\\Classes\\*\\shell\\AutoRAG.ask\\command");
		expect(keys).toContain("HKCU\\Software\\Classes\\Directory\\shell\\AutoRAG.reveal\\command");
		expect(calls).toContainEqual(["add", "HKCU\\Software\\Classes\\*\\shell\\AutoRAG.ask", "/ve", "/d", "Ask AutoRAG", "/f"]);
	});

	it("builds a command line Explorer can run", () => {
		expect(winVerbCommand(deps.execPath, ["C:\\dev\\app"], "ask")).toBe(
			'"C:\\Program Files\\AutoRAG\\AutoRAG.exe" "C:\\dev\\app" --autorag-request=ask "--autorag-path=%1"',
		);
	});

	it("removes the verb keys it wrote, and nothing else", () => {
		expect(winUninstallCommands().map((call) => call[1])).toEqual([
			"HKCU\\Software\\Classes\\*\\shell\\AutoRAG.ask",
			"HKCU\\Software\\Classes\\*\\shell\\AutoRAG.reveal",
			"HKCU\\Software\\Classes\\Directory\\shell\\AutoRAG.ask",
			"HKCU\\Software\\Classes\\Directory\\shell\\AutoRAG.reveal",
		]);
	});

	it("uninstall finishes the rest when a key was never written", async () => {
		const attempted: string[] = [];
		const menu = createOsMenuIntegration({
			platform: "win32",
			homeDir: "C:\\Users\\x",
			...deps,
			run: async (_command, args) => {
				attempted.push(args[1] ?? "");
				throw new Error("The system was unable to find the specified registry key");
			},
		});
		await expect(menu.uninstall()).resolves.toBeUndefined();
		expect(attempted).toHaveLength(4);
	});

	it("a failed registry write rejects install, so the setting is not saved as on", async () => {
		const menu = createOsMenuIntegration({
			platform: "win32",
			homeDir: "C:\\Users\\x",
			...deps,
			run: async () => {
				throw new Error("Access is denied");
			},
		});
		await expect(menu.install(LABELS)).rejects.toThrow("Access is denied");
	});
});

describe("other platforms", () => {
	it("report unsupported and do nothing", async () => {
		const menu = createOsMenuIntegration({ platform: "linux", homeDir: "/home/x", execPath: "/x", appArgs: [], run: () => Promise.reject(new Error("must not run")) });
		expect(menu.supported).toBe(false);
		await expect(menu.install(LABELS)).resolves.toBeUndefined();
	});
});
