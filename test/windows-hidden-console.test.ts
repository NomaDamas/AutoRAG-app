import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRun } from "../src/main/action-service";
import { createDupeyProbe } from "../src/main/dupey";
import { createOsKindResolver } from "../src/main/file-kind";
import { sampleMinSyncProcesses } from "../src/main/minsync-watchdog";
import { runCommand } from "../src/main/refresh-scheduler";

/**
 * On Windows a GUI process that starts a console program without `windowsHide`
 * makes the OS flash a black console window. Navigating a folder looked up the
 * file kind through PowerShell, so every new folder flashed one. Every helper
 * the app starts on Windows must ask for a hidden window.
 */

interface Started {
	readonly command: string;
	readonly options: { readonly windowsHide?: boolean } | undefined;
}

const started = vi.hoisted((): Started[] => []);

vi.mock("node:child_process", () => {
	type Done = (error: Error | null, stdout: string, stderr: string) => void;
	const execFile = (command: string, _args: readonly string[], options: unknown, callback?: Done) => {
		started.push({ command, options: typeof options === "function" ? undefined : (options as Started["options"]) });
		const done = typeof options === "function" ? (options as Done) : callback;
		queueMicrotask(() => done?.(null, "", ""));
		return { stdin: { end() {} } };
	};
	// `promisify(execFile)` resolves { stdout, stderr }, as the real one does.
	(execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (command: string, args: readonly string[], options: unknown) => {
		const { promise, resolve } = Promise.withResolvers<{ stdout: string; stderr: string }>();
		execFile(command, args, options, (_error, stdout, stderr) => resolve({ stdout, stderr }));
		return promise;
	};
	const spawn = (command: string, _args: readonly string[], options: Started["options"]) => {
		started.push({ command, options });
		const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
		queueMicrotask(() => child.emit("close", 0));
		return child;
	};
	return { execFile, spawn };
});

beforeEach(() => {
	started.length = 0;
});

const hidden = (command: string): boolean | undefined => started.find((entry) => entry.command === command)?.options?.windowsHide;

describe("helper processes on Windows start without a console window", () => {
	it("hides the PowerShell lookup of a file's Explorer type that every folder listing triggers", async () => {
		await createOsKindResolver({ platform: "win32" }).kindFor("C:\\no-such-folder\\a.mp4", ".mp4");
		expect(hidden("powershell.exe")).toBe(true);
	});

	it("hides the dupey --version probe", async () => {
		await createDupeyProbe().status();
		expect(hidden("dupey")).toBe(true);
	});

	it("hides the scheduled-task commands", async () => {
		await runCommand("schtasks", ["/Query"]);
		expect(hidden("schtasks")).toBe(true);
	});

	it("hides the tasklist poll the stall watchdog repeats", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			await sampleMinSyncProcesses();
		} finally {
			if (platform !== undefined) Object.defineProperty(process, "platform", platform);
		}
		expect(hidden("tasklist")).toBe(true);
	});

	it("hides the commands behind file actions (archives, conversions)", async () => {
		await defaultRun("7z", ["l", "x.zip"]);
		expect(hidden("7z")).toBe(true);
	});
});
