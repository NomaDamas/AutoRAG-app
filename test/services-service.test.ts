import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/main/action-service";
import { createServicesService, selectServices, type ServiceSnapshot } from "../src/main/services-service";
import { isServiceRunRequest, splitServiceTitle } from "../src/shared/services-contract";

/** A service dictionary as `pbs -dump_pboard` reports it (fields trimmed to the ones the filter reads). */
function service(title: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		NSMenuItem: { default: title },
		NSMessage: "doIt",
		NSBundleIdentifier: "com.example.app",
		NSSendTypes: ["NSFilenamesPboardType"],
		...fields,
	};
}

const FILE = "/Users/x/Docs/report.pdf";
const FOLDER = "/Users/x/Docs";

/** Every selected path conforms to exactly the types listed; anything else does not. */
function snapshot(
	services: Record<string, unknown>[],
	conformance: Record<string, readonly string[]> = {},
	status: ServiceSnapshot["status"] = {},
): ServiceSnapshot {
	const conforms: Record<string, Record<string, boolean>> = {};
	for (const [path, types] of Object.entries(conformance)) {
		conforms[path] = Object.fromEntries(types.map((type) => [type, true]));
	}
	return { services, conforms, status };
}

const titles = (entries: readonly { id: string }[]): string[] => entries.map((entry) => entry.id);

describe("splitServiceTitle", () => {
	it("splits the application group off the leaf at the first slash", () => {
		expect(splitServiceTitle("Keka/Send to Keka")).toEqual({ group: "Keka", name: "Send to Keka" });
		expect(splitServiceTitle("QSpace Pro/Add to Stash Shelf")).toEqual({ group: "QSpace Pro", name: "Add to Stash Shelf" });
		expect(splitServiceTitle("A/B/C")).toEqual({ group: "A", name: "B/C" });
	});

	it("leaves an ungrouped or malformed title whole", () => {
		expect(splitServiceTitle("New Terminal at Folder")).toEqual({ group: null, name: "New Terminal at Folder" });
		expect(splitServiceTitle("/leading")).toEqual({ group: null, name: "/leading" });
		expect(splitServiceTitle("trailing/")).toEqual({ group: null, name: "trailing/" });
	});
});

describe("isServiceRunRequest", () => {
	it("needs a service id and a non-empty list of absolute paths", () => {
		expect(isServiceRunRequest("Keka/Send to Keka", ["/a"])).toBe(true);
		expect(isServiceRunRequest("", ["/a"])).toBe(false);
		expect(isServiceRunRequest("Keka/Send to Keka", [])).toBe(false);
		expect(isServiceRunRequest("Keka/Send to Keka", ["relative"])).toBe(false);
		expect(isServiceRunRequest("Keka/Send to Keka", ["/a", 3])).toBe(false);
		expect(isServiceRunRequest(7, ["/a"])).toBe(false);
	});
});

describe("selectServices", () => {
	it("keeps the services that take files and drops the ones that only take text", () => {
		const entries = selectServices(
			snapshot([
				service("Keka/Send to Keka"),
				service("Convert Text to Full Width", { NSSendTypes: ["public.rtf", "public.utf8-plain-text"] }),
				service("Open URL", { NSSendTypes: ["NSURLPboardType", "NSStringPboardType"] }),
			]),
			[FILE],
		);
		expect(titles(entries)).toEqual(["Keka/Send to Keka"]);
	});

	it("accepts a text service only when it is about a file path", () => {
		const entries = selectServices(
			snapshot([
				service("Open Selected File in TextEdit", { NSSendTypes: ["public.plain-text"], NSRequiredContext: { NSTextContent: "FilePath" } }),
				service("Open man Page in Terminal", { NSSendTypes: ["public.plain-text"], NSRequiredContext: { NSWordLimit: "20" } }),
				service("Show Map", { NSSendTypes: ["public.utf8-plain-text"], NSRequiredContext: { NSTextContent: "Address" } }),
			]),
			[FILE],
		);
		expect(titles(entries)).toEqual(["Open Selected File in TextEdit"]);
	});

	it("matches a service's file types against every selected path", () => {
		const terminal = service("New Terminal at Folder", {
			NSSendTypes: ["public.plain-text"],
			NSSendFileTypes: ["public.directory"],
			NSRequiredContext: { NSTextContent: "FilePath" },
		});
		const conformance = { [FOLDER]: ["public.directory"], [FILE]: [] };
		expect(titles(selectServices(snapshot([terminal], conformance), [FOLDER]))).toEqual(["New Terminal at Folder"]);
		expect(titles(selectServices(snapshot([terminal], conformance), [FILE]))).toEqual([]);
		// One non-folder in the selection disqualifies it, as in Finder.
		expect(titles(selectServices(snapshot([terminal], conformance), [FOLDER, FILE]))).toEqual([]);
	});

	it("offers Finder quick actions, which carry only file types and the Finder context", () => {
		const workflow = service("Encode Selected Audio Files", {
			NSSendTypes: undefined,
			NSSendFileTypes: ["public.audio"],
			NSRequiredContext: { NSApplicationIdentifier: "com.apple.finder" },
			NSMessage: "runWorkflowAsService",
		});
		expect(titles(selectServices(snapshot([workflow], { "/m/a.mp3": ["public.audio"] }), ["/m/a.mp3"]))).toEqual(["Encode Selected Audio Files"]);
		expect(titles(selectServices(snapshot([workflow], { [FILE]: [] }), [FILE]))).toEqual([]);
	});

	it("drops services bound to some other application", () => {
		const entries = selectServices(
			snapshot([service("Only In Xcode", { NSRequiredContext: { NSApplicationIdentifier: "com.apple.dt.Xcode" } })]),
			[FILE],
		);
		expect(entries).toEqual([]);
	});

	it("drops restricted services, this app's own right-click workflows, and services the user switched off", () => {
		const hidden = service("Hidden By User", { NSBundleIdentifier: "com.example.hide" });
		const entries = selectServices(
			snapshot(
				[
					service("Folder Actions Setup", { NSRestricted: "1" }),
					service("Ask AutoRAG", { NSBundleIdentifier: "com.autorag.app.service.ask" }),
					hidden,
					service("Kept"),
				],
				{},
				{ "com.example.hide - Hidden By User - doIt": { enabled_context_menu: false } },
			),
			[FILE],
		);
		expect(titles(entries)).toEqual(["Kept"]);
	});

	it("keeps a service that is switched off only for the Services menu, not the context menu", () => {
		const entries = selectServices(
			snapshot([service("Kept")], {}, { "com.example.app - Kept - doIt": { enabled_services_menu: false, enabled_context_menu: true } }),
			[FILE],
		);
		expect(titles(entries)).toEqual(["Kept"]);
	});

	it("lists a title once, and orders ungrouped services before each application's group", () => {
		const entries = selectServices(
			snapshot([
				service("Zed/Second"),
				service("Reveal in Bloom"),
				service("Keka/Send to Keka"),
				service("Keka/Compress using Keka"),
				service("Zed/First"),
				service("Reveal in Bloom"),
				service("Another"),
			]),
			[FILE],
		);
		expect(entries).toEqual([
			{ id: "Another", group: null, name: "Another" },
			{ id: "Reveal in Bloom", group: null, name: "Reveal in Bloom" },
			{ id: "Keka/Compress using Keka", group: "Keka", name: "Compress using Keka" },
			{ id: "Keka/Send to Keka", group: "Keka", name: "Send to Keka" },
			{ id: "Zed/First", group: "Zed", name: "First" },
			{ id: "Zed/Second", group: "Zed", name: "Second" },
		]);
	});

	it("tolerates entries the OS reports in an unexpected shape", () => {
		const entries = selectServices(
			snapshot([
				{ NSMenuItem: "not a dictionary" },
				{ NSMenuItem: { default: 12 } },
				{},
				service("Fine", { NSRequiredContext: [{ NSTextContent: "URL" }, { NSApplicationIdentifier: "com.apple.finder" }] }),
			]),
			[FILE],
		);
		expect(titles(entries)).toEqual(["Fine"]);
	});

	it("offers nothing for an empty selection", () => {
		expect(selectServices(snapshot([service("Kept")]), [])).toEqual([]);
	});
});

interface Call {
	readonly command: string;
	readonly args: readonly string[];
}

/** A runner that answers the list script with `listing` and the perform script with `performed`. */
function fakeRunner(options: { listing?: ServiceSnapshot; performed?: string; listFails?: boolean } = {}): { run: CommandRunner; calls: Call[] } {
	const calls: Call[] = [];
	const run: CommandRunner = async (command, args) => {
		calls.push({ command, args: [...args] });
		const script = args[3] ?? "";
		if (script.includes("NSPerformService")) return { stdout: options.performed ?? "performed", stderr: "" };
		if (options.listFails === true) throw new Error("osascript failed");
		return { stdout: JSON.stringify(options.listing ?? snapshot([])), stderr: "" };
	};
	return { run, calls };
}

describe("services service", () => {
	it("lists the services for the selection, handing the paths over as arguments, never in the script", async () => {
		const { run, calls } = fakeRunner({ listing: snapshot([service("Keka/Send to Keka")]) });
		const services = createServicesService({ platform: "darwin", run });
		const path = "/Users/x/it's \"quoted\" $(rm -rf ~).pdf";
		expect(await services.list([path, FOLDER])).toEqual([{ id: "Keka/Send to Keka", group: "Keka", name: "Send to Keka" }]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("osascript");
		expect(calls[0]?.args.slice(0, 2)).toEqual(["-l", "JavaScript"]);
		expect(calls[0]?.args.slice(4)).toEqual([path, FOLDER]);
		expect(calls[0]?.args[3]).not.toContain(path);
	});

	it("offers nothing and runs nothing off macOS", async () => {
		const { run, calls } = fakeRunner({ listing: snapshot([service("Keka/Send to Keka")]) });
		const services = createServicesService({ platform: "win32", run });
		expect(await services.list([FILE])).toEqual([]);
		await expect(services.run("Keka/Send to Keka", [FILE])).rejects.toThrow(/macOS/);
		expect(calls).toEqual([]);
	});

	it("degrades a failed or malformed lookup to an empty menu", async () => {
		expect(await createServicesService({ platform: "darwin", run: fakeRunner({ listFails: true }).run }).list([FILE])).toEqual([]);
		const garbage: CommandRunner = async () => ({ stdout: "not json", stderr: "" });
		expect(await createServicesService({ platform: "darwin", run: garbage }).list([FILE])).toEqual([]);
		const wrongShape: CommandRunner = async () => ({ stdout: JSON.stringify({ services: "nope" }), stderr: "" });
		expect(await createServicesService({ platform: "darwin", run: wrongShape }).list([FILE])).toEqual([]);
	});

	it("does not look anything up for relative paths", async () => {
		const { run, calls } = fakeRunner();
		expect(await createServicesService({ platform: "darwin", run }).list(["relative.txt"])).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("performs a service the OS offers for the selection, passing the id and paths as arguments", async () => {
		const { run, calls } = fakeRunner({ listing: snapshot([service("Keka/Send to Keka")]) });
		const services = createServicesService({ platform: "darwin", run });
		await services.run("Keka/Send to Keka", [FILE, FOLDER]);
		const perform = calls.find((call) => (call.args[3] ?? "").includes("NSPerformService"));
		expect(perform?.command).toBe("osascript");
		expect(perform?.args.slice(4)).toEqual(["Keka/Send to Keka", FILE, FOLDER]);
	});

	it("refuses a service the OS does not offer for this selection, without performing anything", async () => {
		const { run, calls } = fakeRunner({ listing: snapshot([service("Keka/Send to Keka")]) });
		const services = createServicesService({ platform: "darwin", run });
		await expect(services.run("Some/Other Service", [FILE])).rejects.toThrow(/서비스/);
		expect(calls.some((call) => (call.args[3] ?? "").includes("NSPerformService"))).toBe(false);
	});

	it("reports a service the system could not perform", async () => {
		const { run } = fakeRunner({ listing: snapshot([service("Keka/Send to Keka")]), performed: "FAILED" });
		await expect(createServicesService({ platform: "darwin", run }).run("Keka/Send to Keka", [FILE])).rejects.toThrow(/서비스/);
	});
});
