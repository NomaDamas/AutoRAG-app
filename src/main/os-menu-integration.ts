import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import en from "../shared/i18n/locales/en.json";
import ja from "../shared/i18n/locales/ja.json";
import ko from "../shared/i18n/locales/ko.json";
import zh from "../shared/i18n/locales/zh.json";
import { OS_REQUEST_FLAG, OS_REQUEST_PATH_FLAG, type OsRequestAction } from "../shared/os-request-contract";

/**
 * Puts AutoRAG into the OS file menu, the way Keka or Skim do.
 *
 * - macOS: two Quick Action workflows in `~/Library/Services`. Each is a
 *   Services entry limited to Finder selections, so it appears under
 *   right-click → Quick Actions (and Services). Its shell script launches this
 *   app's own executable with the request flags.
 * - Windows: Explorer shell verbs under `HKCU\Software\Classes` for files and
 *   folders. They live in the classic menu ("Show more options" on Windows 11);
 *   the modern top-level menu needs a packaged COM `IExplorerCommand`, which
 *   an unpackaged Electron app cannot register.
 * - Linux: nothing; there is no common file-manager extension point.
 *
 * Both installs are per-user, need no elevation, and are removed by
 * {@link OsMenuIntegration.uninstall}.
 */

/** The actions the menu offers, in menu order. */
export const MENU_ACTIONS: readonly OsRequestAction[] = ["ask", "reveal"];

/** Menu captions per action; the caller supplies them in the interface language. */
export type MenuLabels = Readonly<Record<OsRequestAction, string>>;

export interface OsMenuIntegrationDeps {
	readonly platform: NodeJS.Platform;
	readonly homeDir: string;
	/** The executable a menu entry launches: the packaged app, or Electron when unpackaged. */
	readonly execPath: string;
	/** Arguments before the request flags: the app directory when running unpackaged, else none. */
	readonly appArgs: readonly string[];
	/** Runs one native command with an argv (never a shell). */
	readonly run: (command: string, args: readonly string[]) => Promise<void>;
}

export interface OsMenuIntegration {
	/** Whether this OS has a file-menu extension point the app can use. */
	readonly supported: boolean;
	/** Write (or refresh) the entries; labels follow the current interface language. */
	install(labels: MenuLabels): Promise<void>;
	/** Remove every entry this app wrote. */
	uninstall(): Promise<void>;
}

/** Bundle identifier prefix: how an installed workflow is recognized as ours. */
export const MAC_SERVICE_ID_PREFIX = "com.autorag.app.service.";
const PBS = "/System/Library/CoreServices/pbs";
const WIN_VERB_PREFIX = "AutoRAG.";
/** Registry parents whose `shell` key Explorer reads for a right-click on a file or on a folder. */
const WIN_CLASS_ROOTS = ["*", "Directory"] as const;

/** POSIX single-quote escaping: the one quoting form that keeps every byte literal. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The menu captions per interface language, straight from the locale files (main never loads react-i18next). */
const MENU_CAPTIONS = { ko: ko.osMenu, en: en.osMenu, ja: ja.osMenu, zh: zh.osMenu } as const;

export function menuLabels(language: keyof typeof MENU_CAPTIONS): MenuLabels {
	const { ask, reveal } = MENU_CAPTIONS[language];
	return { ask, reveal };
}

export function xmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The script a macOS workflow runs: the selected items arrive as `"$@"`. */
export function macServiceScript(execPath: string, appArgs: readonly string[], action: OsRequestAction): string {
	const launcher = [execPath, ...appArgs].map(shellQuote).join(" ");
	return [
		"args=()",
		`for item in "$@"; do args+=("${OS_REQUEST_PATH_FLAG}$item"); done`,
		// Detached: when no app is running, this process becomes the app and must outlive the workflow.
		`nohup ${launcher} ${OS_REQUEST_FLAG}${action} "\${args[@]}" >/dev/null 2>&1 &`,
	].join("\n");
}

export function macServiceInfoPlist(action: OsRequestAction, label: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>${xmlEscape(label)}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.item</string>
			</array>
		</dict>
	</array>
	<key>CFBundleIdentifier</key>
	<string>${MAC_SERVICE_ID_PREFIX}${action}</string>
	<key>CFBundleName</key>
	<string>${xmlEscape(label)}</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
</dict>
</plist>
`;
}

/** An Automator "Run Shell Script" workflow that receives Finder items as arguments. */
export function macServiceWorkflow(script: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.path</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>${xmlEscape(script)}</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>6A1E5B0C-3D6F-4B8E-9C1A-2F0D7E4A9B01</string>
				<key>OutputUUID</key>
				<string>0B7C2D91-5E4A-4F63-8A12-C9D3E6F1A502</string>
				<key>UUID</key>
				<string>D4F8A6E2-1B35-4C79-A0E8-7B2C9D5F3A03</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>0</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string>/bin/sh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>isViewVisible</key>
				<integer>1</integer>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`;
}

/** A menu caption becomes a directory name, so path separators and control characters go. */
export function workflowDirName(label: string): string {
	// eslint-disable-next-line no-control-regex
	const safe = label.replace(/[/\\:\u0000-\u001f]/gu, " ").trim();
	return `${safe === "" ? "Dazzi" : safe}.workflow`;
}

/** The registry key (under HKCU) of one verb on one class root. */
export function winVerbKey(root: (typeof WIN_CLASS_ROOTS)[number], action: OsRequestAction): string {
	return `HKCU\\Software\\Classes\\${root}\\shell\\${WIN_VERB_PREFIX}${action}`;
}

/** The command line Explorer runs for a verb; `%1` is the clicked item. */
export function winVerbCommand(execPath: string, appArgs: readonly string[], action: OsRequestAction): string {
	const launcher = [execPath, ...appArgs].map((part) => `"${part}"`).join(" ");
	return `${launcher} ${OS_REQUEST_FLAG}${action} "${OS_REQUEST_PATH_FLAG}%1"`;
}

/** The `reg.exe` calls that write every verb. `/f` overwrites, so a refresh is the same call. */
export function winInstallCommands(deps: Pick<OsMenuIntegrationDeps, "execPath" | "appArgs">, labels: MenuLabels): readonly (readonly string[])[] {
	const calls: string[][] = [];
	for (const root of WIN_CLASS_ROOTS) {
		for (const action of MENU_ACTIONS) {
			const key = winVerbKey(root, action);
			calls.push(["add", key, "/ve", "/d", labels[action], "/f"]);
			calls.push(["add", key, "/v", "Icon", "/d", `"${deps.execPath}",0`, "/f"]);
			calls.push(["add", `${key}\\command`, "/ve", "/d", winVerbCommand(deps.execPath, deps.appArgs, action), "/f"]);
		}
	}
	return calls;
}

/** The `reg.exe` calls that remove every verb; a verb that is not there is not an error. */
export function winUninstallCommands(): readonly (readonly string[])[] {
	return WIN_CLASS_ROOTS.flatMap((root) => MENU_ACTIONS.map((action) => ["delete", winVerbKey(root, action), "/f"]));
}

/** The `~/Library/Services` workflow directories this app wrote, found by their bundle identifier. */
async function ownedWorkflows(servicesDir: string): Promise<readonly string[]> {
	let names: string[];
	try {
		names = await readdir(servicesDir);
	} catch {
		return [];
	}
	const owned: string[] = [];
	for (const name of names) {
		if (!name.endsWith(".workflow")) continue;
		const plist = await readFile(join(servicesDir, name, "Contents", "Info.plist"), "utf8").catch(() => "");
		if (plist.includes(`<string>${MAC_SERVICE_ID_PREFIX}`)) owned.push(name);
	}
	return owned;
}

export function createOsMenuIntegration(deps: OsMenuIntegrationDeps): OsMenuIntegration {
	if (deps.platform === "darwin") {
		const servicesDir = join(deps.homeDir, "Library", "Services");
		/** The Services database only learns of a workflow change on `pbs -update`; the entries work after a restart without it. */
		const refreshServices = (): Promise<void> => deps.run(PBS, ["-update"]).catch((error: unknown) => console.warn("[os-menu] pbs -update failed:", error));
		const removeOwned = async (): Promise<void> => {
			for (const name of await ownedWorkflows(servicesDir)) await rm(join(servicesDir, name), { recursive: true, force: true });
		};
		return {
			supported: true,
			async install(labels) {
				// Removed first: a language change renames the workflow, and the old name must not linger.
				await removeOwned();
				for (const action of MENU_ACTIONS) {
					const contents = join(servicesDir, workflowDirName(labels[action]), "Contents");
					await mkdir(contents, { recursive: true });
					await writeFile(join(contents, "Info.plist"), macServiceInfoPlist(action, labels[action]), "utf8");
					await writeFile(join(contents, "document.wflow"), macServiceWorkflow(macServiceScript(deps.execPath, deps.appArgs, action)), "utf8");
				}
				await refreshServices();
			},
			async uninstall() {
				await removeOwned();
				await refreshServices();
			},
		};
	}
	if (deps.platform === "win32") {
		return {
			supported: true,
			async install(labels) {
				for (const args of winInstallCommands(deps, labels)) await deps.run("reg.exe", args);
			},
			async uninstall() {
				// `reg delete` fails for a key that was never written; uninstall must still finish the rest.
				for (const args of winUninstallCommands()) await deps.run("reg.exe", args).catch(() => undefined);
			},
		};
	}
	return { supported: false, install: async () => undefined, uninstall: async () => undefined };
}
