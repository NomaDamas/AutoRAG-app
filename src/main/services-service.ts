import { splitServiceTitle, type ServiceEntry } from "../shared/services-contract";
import { defaultRun, type CommandRunner } from "./action-service";

/**
 * macOS Services for the in-app right-click menu.
 *
 * The system keeps a registry of every service installed apps declare
 * (`pbs -dump_pboard`, the data behind Finder's own Services menu). One
 * `osascript` call reads it, the user's per-service switches, and — for the
 * selected paths — which file types each path conforms to. {@link selectServices}
 * then applies Finder's rules in plain TypeScript. Performing a service goes
 * back through `NSPerformService`, so the target app receives the files exactly
 * as it would from Finder.
 *
 * Paths reach the scripts as `argv`, never as script text, so no file name can
 * alter them.
 */

/** What the list script reports: the registry, the user's switches, and per-path type conformance. */
export interface ServiceSnapshot {
	/** `pbs -dump_pboard` entries as the OS printed them; `parseService` reads only the fields it needs. */
	readonly services: readonly unknown[];
	/** `conforms[path][uti]` is true when the path's file type conforms to `uti` (only the types services name are asked). */
	readonly conforms: unknown;
	/** `NSServicesStatus`, keyed `bundleId - menu title - message`. */
	readonly status: unknown;
}

export interface ServicesService {
	list(paths: readonly string[]): Promise<readonly ServiceEntry[]>;
	run(id: string, paths: readonly string[]): Promise<void>;
}

export interface ServicesServiceDeps {
	/** Defaults to process.platform. */
	readonly platform?: NodeJS.Platform;
	/** Defaults to spawning the command with execFile. */
	readonly run?: CommandRunner;
}

/** The registry fields Finder's rules read, parsed once from an entry the OS printed. */
interface PbsService {
	readonly title: string;
	readonly bundleId: string;
	readonly message: string;
	readonly restricted: boolean;
	readonly sendTypes: readonly string[];
	readonly sendFileTypes: readonly string[];
	/** `NSRequiredContext`: one dictionary or a list of alternatives. */
	readonly contexts: readonly { readonly application: string | null; readonly textContent: string | null }[];
}

/** The bundle identifier prefix of this app's own Finder Quick Actions; offering them inside the app would be circular. */
const OWN_SERVICE_PREFIX = "com.autorag.app.service.";
const FINDER = "com.apple.finder";
const FILE_PASTEBOARD_TYPES: readonly string[] = ["NSFilenamesPboardType", "public.file-url"];
const TEXT_PASTEBOARD_TYPES: readonly string[] = ["public.plain-text", "public.utf8-plain-text", "NSStringPboardType"];

const LIST_TIMEOUT_MS = 10_000;
const PERFORM_TIMEOUT_MS = 30_000;

const LIST_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("CoreServices");
function run(argv) {
	const task = $.NSTask.alloc.init;
	task.executableURL = $.NSURL.fileURLWithPath("/System/Library/CoreServices/pbs");
	task.arguments = $(["-dump_pboard"]);
	const pipe = $.NSPipe.pipe;
	task.standardOutput = pipe;
	task.standardError = $.NSPipe.pipe;
	task.launchAndReturnError(null);
	const data = pipe.fileHandleForReading.readDataToEndOfFile;
	task.waitUntilExit;
	const raw = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
	// The dump prints each NSUUID as "{length = 20, bytes = ...}", which is not property-list syntax.
	const text = raw.replace(/^\\s*NSUUID = \\{[^\\n]*$/gm, "");
	const parsed = $.NSPropertyListSerialization.propertyListWithDataOptionsFormatError($(text).dataUsingEncoding($.NSUTF8StringEncoding), 0, null, null);
	const services = parsed.isNil() ? [] : ObjC.deepUnwrap(parsed);
	const prefs = $.NSUserDefaults.standardUserDefaults.persistentDomainForName("pbs");
	const status = prefs.isNil() ? {} : (ObjC.deepUnwrap(prefs).NSServicesStatus || {});
	const wanted = {};
	for (const service of services) for (const type of (service.NSSendFileTypes || [])) wanted[type] = true;
	const conforms = {};
	for (const path of argv) {
		const ref = Ref();
		$.NSURL.fileURLWithPath(path).getResourceValueForKeyError(ref, $("NSURLTypeIdentifierKey"), null);
		const uti = ref[0].isNil() ? null : ObjC.unwrap(ref[0]);
		const row = {};
		for (const type of Object.keys(wanted)) row[type] = uti !== null && $.UTTypeConformsTo($(uti), $(type));
		conforms[path] = row;
	}
	return JSON.stringify({ services: services, conforms: conforms, status: status });
}
`;

/** Performs the named service on the files, then keeps the process alive long enough for the system to hand them over. */
const PERFORM_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
	const name = argv[0];
	const files = argv.slice(1);
	const pb = $.NSPasteboard.pasteboardWithUniqueName;
	pb.clearContents;
	pb.writeObjects($(files.map((file) => $.NSURL.fileURLWithPath(file))));
	pb.addTypesOwner($(["NSFilenamesPboardType", "NSStringPboardType"]), null);
	pb.setPropertyListForType($(files), $("NSFilenamesPboardType"));
	pb.setStringForType($(files.join("\\n")), $("NSStringPboardType"));
	const ok = $.NSPerformService($(name), pb);
	// A workflow service is dispatched asynchronously; exiting at once would drop it.
	$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(1.5));
	return ok ? "performed" : "FAILED";
}
`;

function stringList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * `value[key]` for a plist dictionary: undefined unless `value` is a non-array
 * object that holds `key`. Reads of OS-printed data go through here, so a
 * missing or oddly shaped field is "absent", never a throw.
 */
function field(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return Reflect.get(value, key);
}

function stringField(value: unknown, key: string): string | null {
	const found = field(value, key);
	return typeof found === "string" ? found : null;
}

function parseContexts(value: unknown): PbsService["contexts"] {
	const alternatives: readonly unknown[] = Array.isArray(value) ? value : [value];
	return alternatives.flatMap((alternative) =>
		typeof alternative === "object" && alternative !== null && !Array.isArray(alternative)
			? [{ application: stringField(alternative, "NSApplicationIdentifier"), textContent: stringField(alternative, "NSTextContent") }]
			: [],
	);
}

/** One registry entry, or null when it has no usable menu title. */
function parseService(entry: unknown): PbsService | null {
	const title = stringField(field(entry, "NSMenuItem"), "default");
	if (title === null || title.length === 0) return null;
	const restricted = field(entry, "NSRestricted");
	return {
		title,
		bundleId: stringField(entry, "NSBundleIdentifier") ?? "",
		message: stringField(entry, "NSMessage") ?? "",
		restricted: restricted === "1" || restricted === 1 || restricted === true,
		sendTypes: stringList(field(entry, "NSSendTypes")),
		sendFileTypes: stringList(field(entry, "NSSendFileTypes")),
		contexts: parseContexts(field(entry, "NSRequiredContext")),
	};
}

/** A service with no context, or one whose context allows Finder, can run from a file manager. */
function contextAllowsFiles(service: PbsService): boolean {
	return service.contexts.length === 0 || service.contexts.some((context) => context.application === null || context.application === FINDER);
}

function takesFiles(service: PbsService): boolean {
	// Quick Actions and "this kind of file" services name the file types they accept.
	if (service.sendFileTypes.length > 0) return true;
	if (service.sendTypes.some((type) => FILE_PASTEBOARD_TYPES.includes(type))) return true;
	// A text service is about files only when it declares that its text is a file path.
	return service.sendTypes.some((type) => TEXT_PASTEBOARD_TYPES.includes(type)) && service.contexts.some((context) => context.textContent === "FilePath");
}

/** The user can switch a service off for the context menu in System Settings → Keyboard → Shortcuts → Services. */
function switchedOff(service: PbsService, status: unknown): boolean {
	const entry = field(status, `${service.bundleId} - ${service.title} - ${service.message}`);
	return field(entry, "enabled_context_menu") === false || field(field(entry, "presentation_modes"), "ContextMenu") === false;
}

/** Every selected path must conform to at least one of the file types the service names. */
function acceptsSelection(service: PbsService, paths: readonly string[], conforms: unknown): boolean {
	if (service.sendFileTypes.length === 0) return true;
	return paths.every((path) => service.sendFileTypes.some((type) => field(field(conforms, path), type) === true));
}

/**
 * The services Finder would list for `paths`, as menu entries: ungrouped
 * services first, then each application's group, alphabetical, each title once.
 */
export function selectServices(snapshot: ServiceSnapshot, paths: readonly string[]): readonly ServiceEntry[] {
	if (paths.length === 0) return [];
	const byId = new Map<string, ServiceEntry>();
	for (const entry of snapshot.services) {
		const service = parseService(entry);
		if (service === null || byId.has(service.title) || service.restricted) continue;
		if (service.bundleId.startsWith(OWN_SERVICE_PREFIX)) continue;
		if (!contextAllowsFiles(service) || !takesFiles(service)) continue;
		if (!acceptsSelection(service, paths, snapshot.conforms) || switchedOff(service, snapshot.status)) continue;
		byId.set(service.title, { id: service.title, ...splitServiceTitle(service.title) });
	}
	return [...byId.values()].sort((a, b) => {
		if ((a.group === null) !== (b.group === null)) return a.group === null ? -1 : 1;
		return (a.group ?? "").localeCompare(b.group ?? "") || a.name.localeCompare(b.name);
	});
}

/** The script's JSON document, or null when it is not the shape the script prints. */
function parseSnapshot(stdout: string): ServiceSnapshot | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	const services = field(parsed, "services");
	if (!Array.isArray(services)) return null;
	return { services, conforms: field(parsed, "conforms"), status: field(parsed, "status") };
}

export function createServicesService(deps: ServicesServiceDeps = {}): ServicesService {
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? defaultRun;

	async function list(paths: readonly string[]): Promise<readonly ServiceEntry[]> {
		if (platform !== "darwin" || paths.length === 0 || !paths.every((path) => path.startsWith("/"))) return [];
		let stdout: string;
		try {
			({ stdout } = await run("osascript", ["-l", "JavaScript", "-e", LIST_SCRIPT, ...paths], { timeoutMs: LIST_TIMEOUT_MS }));
		} catch {
			// A failed lookup is an empty menu, never a broken one.
			return [];
		}
		const snapshot = parseSnapshot(stdout);
		return snapshot === null ? [] : selectServices(snapshot, paths);
	}

	return {
		list,
		async run(id, paths) {
			if (platform !== "darwin") throw new Error("서비스는 macOS에서만 사용할 수 있습니다");
			// Only a service the OS offers for exactly this selection may run: the id comes from the renderer.
			if (!(await list(paths)).some((entry) => entry.id === id)) throw new Error("이 선택에는 사용할 수 없는 서비스입니다");
			const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", PERFORM_SCRIPT, id, ...paths], { timeoutMs: PERFORM_TIMEOUT_MS });
			if (stdout.trim() !== "performed") throw new Error("서비스를 실행하지 못했습니다");
		},
	};
}
