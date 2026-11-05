import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEMO_AUTOMATION_ID, DEMO_MAGIC_ACTION_ID, type DemoAutomationReady, type DemoBridge, type DemoMagicActionReady, type DemoTrigger } from "../shared/demo-contract";
import type { AutomationsSnapshot } from "../shared/automation-contract";
import type { MagicAction } from "../shared/context-menu-contract";
import type { AppSettings } from "../shared/settings-contract";
import { t } from "../shared/i18n/core";
import type { AutomationCliResult } from "./automation-service";

/**
 * The practice material of the contextual tutorials (see `shared/demo-contract.ts`): a real folder, a real rule in
 * the rules file, a real Magic Action in the settings. Everything is idempotent: running a tutorial twice reuses
 * what is there, and nothing the person made is ever overwritten except the demo's own rule, script, and action.
 */

export interface DemoServiceDeps {
	/** The user's home folder; the practice folder is created directly under it. */
	readonly home: string;
	/** `<AUTORAG_HOME>`: where the rule's helper script is kept, beside the rules file. */
	readonly autoragHome: string;
	readonly platform: NodeJS.Platform;
	readonly automations: {
		upsert(entry: Readonly<Record<string, unknown>> & { readonly id: string }): Promise<AutomationsSnapshot>;
		setDaemon(enabled: boolean): Promise<AutomationsSnapshot>;
		snapshot(): Promise<AutomationsSnapshot>;
	};
	/** Runs `autorag <args>`; the daemon-less fallback runs the rule once through `automate run`. */
	readonly run: (args: readonly string[]) => Promise<AutomationCliResult>;
	readonly settings: {
		get(): Promise<AppSettings>;
		set(patch: Partial<AppSettings>): Promise<AppSettings>;
	};
}

/** The rule's command: moves every file it is given into `<sorted>/<kind>` and prints one line per move. */
const SORT_SCRIPT = `import { mkdirSync, renameSync, existsSync } from "node:fs";
import { basename, extname, join, parse } from "node:path";

const [sortedRoot, namesJson, ...files] = process.argv.slice(2);
const names = JSON.parse(namesJson);
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".heic", ".webp"]);
const DOCS = new Set([".pdf", ".doc", ".docx", ".hwp", ".hwpx", ".txt", ".md", ".xls", ".xlsx", ".ppt", ".pptx", ".csv"]);

for (const file of files) {
	if (!existsSync(file)) continue;
	const ext = extname(file).toLowerCase();
	const kind = IMAGES.has(ext) ? names.images : DOCS.has(ext) ? names.documents : names.other;
	const dir = join(sortedRoot, kind);
	mkdirSync(dir, { recursive: true });
	let target = join(dir, basename(file));
	for (let n = 2; existsSync(target); n += 1) target = join(dir, parse(file).name + " " + n + parse(file).ext);
	renameSync(file, target);
	console.log(basename(file) + " -> " + kind);
}
`;

const GLANCE_SH = `for f in "$@"; do
  echo "$(basename "$f")"
  echo "  $(wc -c < "$f" | tr -d ' ') bytes · $(wc -l < "$f" | tr -d ' ') lines"
  echo
  head -n 6 "$f"
  echo
done`;

const GLANCE_PS = `foreach ($f in $args) {
  $item = Get-Item -LiteralPath $f
  Write-Output $item.Name
  Write-Output ("  {0} bytes" -f $item.Length)
  Write-Output ""
  Get-Content -LiteralPath $f -TotalCount 6
  Write-Output ""
}`;

export interface DemoPaths {
	readonly root: string;
	readonly inbox: string;
	readonly sorted: string;
	readonly samples: string;
}

function pathsFor(home: string, folder: string): DemoPaths {
	const root = join(home, folder);
	return { root, inbox: join(root, t("main.demo.inbox")), sorted: join(root, t("main.demo.sorted")), samples: join(root, t("main.demo.samples")) };
}

export function createDemoService(deps: DemoServiceDeps): DemoBridge {
	/** The practice folder: the one an existing demo rule already watches (the language may have changed since), else a fresh localized name. */
	const paths = async (): Promise<DemoPaths> => {
		const snapshot = await deps.automations.snapshot().catch(() => null);
		const rule = snapshot?.rules.find((candidate) => candidate.id === DEMO_AUTOMATION_ID);
		const watched = rule?.paths[0];
		if (rule === undefined || watched === undefined) return pathsFor(deps.home, t("main.demo.folder"));
		const root = dirname(watched);
		return { root, inbox: watched, sorted: rule.run[2] ?? join(root, t("main.demo.sorted")), samples: join(root, t("main.demo.samples")) };
	};

	const writeSample = async (path: string, body: string): Promise<void> => {
		if (!existsSync(path)) await writeFile(path, body, "utf8");
	};

	const kindNames = (): string =>
		JSON.stringify({ documents: t("main.demo.kinds.documents"), images: t("main.demo.kinds.images"), other: t("main.demo.kinds.other") });

	return {
		prepareAutomation: async (): Promise<DemoAutomationReady> => {
			const where = await paths();
			await mkdir(where.inbox, { recursive: true });
			await mkdir(where.sorted, { recursive: true });
			const script = join(deps.autoragHome, "demo", "sort-inbox.mjs");
			await mkdir(join(deps.autoragHome, "demo"), { recursive: true });
			await writeFile(script, SORT_SCRIPT, "utf8");
			await deps.automations.upsert({
				id: DEMO_AUTOMATION_ID,
				paths: [where.inbox],
				events: ["create"],
				include: ["**"],
				run: ["node", script, where.sorted, kindNames()],
				appendFiles: true,
				debounceMs: 800,
			});
			let daemon = false;
			try {
				const snapshot = await deps.automations.setDaemon(true);
				daemon = snapshot.daemon?.running === true;
			} catch {
				daemon = false;
			}
			return { root: where.root, inbox: where.inbox, daemon };
		},

		triggerAutomation: async (): Promise<DemoTrigger> => {
			const where = await paths();
			await mkdir(where.inbox, { recursive: true });
			const name = t("main.demo.dropName");
			const dropped = join(where.inbox, name);
			await writeFile(dropped, t("main.demo.dropBody"), "utf8");
			const snapshot = await deps.automations.snapshot().catch(() => null);
			// With the background service running it picks the file up by itself; without one, run the rule once so the person still sees it work.
			if (snapshot?.daemon?.running !== true) {
				await deps.run(["automate", "run", DEMO_AUTOMATION_ID, "--event", `create:${dropped}`]);
			}
			return { dropped, destination: join(where.sorted, t("main.demo.kinds.documents")) };
		},

		prepareMagicAction: async (): Promise<DemoMagicActionReady> => {
			const where = await paths();
			await mkdir(where.samples, { recursive: true });
			const sample = join(where.samples, t("main.demo.sampleName"));
			await writeSample(sample, t("main.demo.sampleBody"));
			const command = deps.platform === "win32" ? GLANCE_PS : GLANCE_SH;
			const action: MagicAction = {
				id: DEMO_MAGIC_ACTION_ID,
				label: t("main.demo.glanceLabel"),
				description: t("main.demo.glanceDesc"),
				enabled: true,
				selection: "any",
				targetKind: "file",
				extensions: ["txt", "md", "csv"],
				execution: { kind: "script", command },
			};
			const current = await deps.settings.get();
			const others = current.contextMenu.magicActions.filter((item) => item.id !== action.id);
			await deps.settings.set({ contextMenu: { ...current.contextMenu, magicActions: [...others, action] } });
			return { root: where.root, sample };
		},
	};
}
