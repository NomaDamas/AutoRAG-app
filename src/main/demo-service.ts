import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEMO_MAGIC_ACTION_ID, type DemoBridge, type DemoMagicActionReady, type DemoPhotoReady } from "../shared/demo-contract";
import type { AutomationsSnapshot } from "../shared/automation-contract";
import type { MagicAction } from "../shared/context-menu-contract";
import type { AppSettings } from "../shared/settings-contract";
import { t } from "../shared/i18n/core";
import referencePhotoPath from "./demo-assets/reference-photo.jpg?asset";

/**
 * The practice material of the contextual tutorials (see `shared/demo-contract.ts`): a real folder, a real rule in
 * the rules file, a real Magic Action in the settings. Everything is idempotent: running a tutorial twice reuses
 * what is there, and nothing the person made is ever overwritten except the demo's own rule, script, and action.
 */

export interface DemoServiceDeps {
	/** The user's home folder; the practice folder is created directly under it. */
	readonly home: string;
	/** The real Downloads folder (the OS may have moved it), which the AI-made rule is told to watch. */
	readonly downloads: string;
	readonly platform: NodeJS.Platform;
	readonly automations: {
		setDaemon(enabled: boolean): Promise<AutomationsSnapshot>;
		snapshot(): Promise<AutomationsSnapshot>;
	};
	readonly settings: {
		get(): Promise<AppSettings>;
		set(patch: Partial<AppSettings>): Promise<AppSettings>;
	};
	/** The sample photo to copy; defaults to the one the app ships. */
	readonly photoSource?: string;
}

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

function rootOf(home: string): string {
	return join(home, t("main.demo.folder"));
}

/** `IMG_0001.jpg`: the kind of name a camera gives. */
const PLACEHOLDER_PHOTO = "IMG_0001.jpg";

export function createDemoService(deps: DemoServiceDeps): DemoBridge {
	const writeSample = async (path: string, body: string): Promise<void> => {
		if (!existsSync(path)) await writeFile(path, body, "utf8");
	};

	return {
		preparePhoto: async (): Promise<DemoPhotoReady> => {
			const folder = join(rootOf(deps.home), t("main.demo.photos"));
			await mkdir(folder, { recursive: true });
			const photo = join(folder, PLACEHOLDER_PHOTO);
			// A fresh copy each time, so the lesson can be run again; a photo already moved away is simply put back.
			if (!existsSync(photo)) await copyFile(deps.photoSource ?? referencePhotoPath, photo);
			return { folder, photo, downloads: deps.downloads, gray: join(deps.downloads, t("main.demo.gray")) };
		},

		ensureDaemon: async (): Promise<boolean> => {
			const snapshot = await deps.automations.snapshot().catch(() => null);
			if (snapshot?.daemon?.running === true) return true;
			try {
				return (await deps.automations.setDaemon(true)).daemon?.running === true;
			} catch {
				return false;
			}
		},

		prepareMagicAction: async (): Promise<DemoMagicActionReady> => {
			const root = rootOf(deps.home);
			const samples = join(root, t("main.demo.samples"));
			await mkdir(samples, { recursive: true });
			const sample = join(samples, t("main.demo.sampleName"));
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
			return { root, sample };
		},
	};
}
