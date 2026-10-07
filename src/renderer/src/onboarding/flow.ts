/**
 * Pure onboarding logic: the step flow, advance gates, ETA math, folder and
 * source formatting, and the source-description drafter.
 *
 * Everything here is a plain function of its arguments so the flow can be
 * tested without React, Electron, or the bridge. i18n is injected as a
 * `translate` callback so the drafter stays testable and the copy still lives
 * in the locale files.
 */

import type {
	FolderScan,
	IndexingPhase,
	OnboardingStepId,
	PlanId,
	SourceFacts,
	SourceId,
} from "../../../shared/onboarding-contract";
import { CLOUD_FILES_PER_MINUTE, LOCAL_FILES_PER_MINUTE } from "../../../shared/onboarding-contract";

export type EmbedMode = "local" | "cloud";

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The prototype's `flow()`: cloud embedding puts the plan step right after
 * embedding; a confirmed plan drops out of the list, and the model step only
 * exists for BYOK. (Cloud embedding is unavailable in the product, so the
 * shipped flow is welcome → permissions → account → folders → embedding →
 * sources → [plan] → [model] → indexing.)
 */
export function buildFlow(plan: PlanId, planConfirmed: boolean, embed: EmbedMode): OnboardingStepId[] {
	const mid: OnboardingStepId[] = embed === "cloud" ? ["plan", "sources"] : ["sources", "plan"];
	const tail: OnboardingStepId[] = plan === "byok" ? ["model", "indexing"] : ["indexing"];
	const head: OnboardingStepId[] = ["welcome", "permissions", "account", "folders", "embedding"];
	return head.concat(planConfirmed ? mid.filter((id) => id !== "plan") : mid).concat(tail);
}

export function stepIndex(flow: readonly OnboardingStepId[], stepId: OnboardingStepId): number {
	return Math.max(0, flow.indexOf(stepId));
}

export interface AdvanceState {
	readonly stepId: OnboardingStepId;
	readonly platform: string;
	readonly fullDiskAccess: boolean;
	readonly signedIn: boolean;
	readonly selectedFolders: number;
	readonly embed: EmbedMode;
	readonly cloudConsent: boolean;
	readonly plan: PlanId;
	readonly modelVerified: boolean;
}

/** The prototype's `canNext()`: the gate on the footer's primary button. */
export function canAdvance(state: AdvanceState): boolean {
	switch (state.stepId) {
		case "permissions":
			return state.platform === "win32" || state.fullDiskAccess;
		case "account":
			return state.signedIn;
		case "folders":
			return state.selectedFolders > 0;
		case "embedding":
			return state.embed === "local" || state.cloudConsent;
		case "model":
			return state.plan !== "byok" || state.modelVerified;
		default:
			return true;
	}
}

/** The prototype's `nextLabel()`: the footer primary's label for the step. */
export function primaryLabelKey(stepId: OnboardingStepId, plan: PlanId, paid: PlanId | null): string {
	if (stepId !== "plan") {
		return `onboarding.stepLabel.${stepId}`;
	}
	if (plan === paid || plan === "free" || plan === "byok") {
		return "onboarding.plan.continue";
	}
	return plan === "pro" ? "onboarding.plan.startTrial" : "onboarding.plan.subscribeAir";
}

/** Files-per-minute ETA the prototype computes with `eta(mode)`. */
export function etaMinutes(files: number, mode: EmbedMode): number {
	const rate = mode === "cloud" ? CLOUD_FILES_PER_MINUTE : LOCAL_FILES_PER_MINUTE;
	return Math.max(1, Math.ceil(files / rate));
}

export interface ScanTotals {
	readonly files: number;
	readonly bytes: number;
	readonly onlineOnly: number;
}

/** Sums the pre-scan for the selected folders, ignoring scans not yet started. */
export function scanTotals(paths: readonly string[], scans: ReadonlyMap<string, FolderScan>): ScanTotals {
	let files = 0;
	let bytes = 0;
	let onlineOnly = 0;
	for (const path of paths) {
		const scan = scans.get(path);
		if (scan !== undefined) {
			files += scan.files;
			bytes += scan.bytes;
			onlineOnly += scan.onlineOnly;
		}
	}
	return { files, bytes, onlineOnly };
}

/** "1.2 GB" / "812 MB" — decimal units, the prototype's `size` strings. */
export function formatSize(bytes: number): string {
	if (bytes >= 1_000_000_000) {
		return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
	}
	if (bytes >= 1_000_000) {
		return `${Math.round(bytes / 1_000_000)} MB`;
	}
	return `${Math.round(bytes / 1000)} KB`;
}

/** Icon name and colour for a connector's tile (prototype `sources[]`). */
export function sourceTile(id: SourceId): { readonly brand?: string; readonly icon: string; readonly color: string } {
	switch (id) {
		case "spotlight":
			return { icon: "search", color: "blue" };
		case "github":
			return { brand: "github", icon: "git-branch", color: "green" };
		case "obsidian":
			return { brand: "obsidian", icon: "notebook-pen", color: "purple" };
		case "mail":
			return { brand: "apple", icon: "mail", color: "red" };
		case "slack":
			return { brand: "slack", icon: "message-circle", color: "purple" };
	}
}

/** The default datasource access tag each enabled connector grants. */
export function sourceTag(id: SourceId): string {
	return id === "mail" ? "mail" : id;
}

/** A connector's second line, built from its detected facts. */
export function sourceDetail(id: SourceId, facts: SourceFacts, needsFullDiskAccess: boolean, translate: Translate): string {
	switch (id) {
		case "spotlight":
			return translate("onboarding.sources.detail.spotlight");
		case "github":
			return translate("onboarding.sources.detail.github", { repos: facts.repos?.length ?? 0 });
		case "obsidian":
			return translate("onboarding.sources.detail.obsidian", { vaults: facts.vaults?.length ?? 0 });
		case "mail":
			return needsFullDiskAccess
				? translate("onboarding.sources.detail.mailNeedsFda")
				: translate("onboarding.sources.detail.mail");
		case "slack":
			return translate("onboarding.sources.detail.slack", { workspaces: facts.workspaces ?? 0 });
	}
}

/** How many description templates each connector offers (the "다시 쓰기" cycle). */
export const DESCRIPTION_VARIANTS = 3;

/**
 * Drafts the agent-facing description from detected metadata. `variant` cycles
 * through the templates so "다시 쓰기" offers a different wording.
 */
export function draftDescription(
	id: SourceId,
	facts: SourceFacts,
	variant: number,
	translate: Translate,
): string {
	const index = ((variant % DESCRIPTION_VARIANTS) + DESCRIPTION_VARIANTS) % DESCRIPTION_VARIANTS;
	return translate(`onboarding.sources.desc.${id}.${index}`, {
		repos: facts.repos?.length ?? 0,
		firstRepo: facts.repos?.[0] ?? "",
		vaults: facts.vaults?.length ?? 0,
		workspaces: facts.workspaces ?? 0,
		mailboxes: facts.mailboxes ?? 0,
	});
}

/** Phase → position in the indexing phase strip. */
export function phaseIndex(phase: IndexingPhase): number {
	switch (phase) {
		case "parsed":
			return 0;
		case "minsync":
			return 1;
		case "datasources":
			return 2;
		case "finalizing":
			return 3;
	}
}

export type TipArt =
	| { readonly kind: "shortcut"; readonly mod: boolean; readonly key: string }
	| { readonly kind: "space" }
	| { readonly kind: "bubble" }
	| { readonly kind: "drag" }
	| { readonly kind: "versions" }
	| { readonly kind: "brands" };

/** The 9 tips, matching the prototype's order; copy comes from the locale files. */
export const TIPS: readonly TipArt[] = [
	{ kind: "shortcut", mod: true, key: "K" },
	{ kind: "bubble" },
	{ kind: "space" },
	{ kind: "drag" },
	{ kind: "versions" },
	{ kind: "shortcut", mod: true, key: "F" },
	{ kind: "shortcut", mod: true, key: "2" },
	{ kind: "brands" },
	{ kind: "shortcut", mod: true, key: "," },
];

/** The chips shown in the "connect more" row and the tip-8 brand strip. */
export const EXTRA_BRANDS: readonly { readonly brand: string; readonly label: string }[] = [
	{ brand: "kakaotalk", label: "KakaoTalk" },
	{ brand: "notion", label: "Notion" },
	{ brand: "discord", label: "Discord" },
	{ brand: "telegram", label: "Telegram" },
	{ brand: "googledrive", label: "Google Drive" },
];

/** The welcome feature card's source-token grid order. */
export const WELCOME_BRANDS: readonly string[] = [
	"apple",
	"slack",
	"telegram",
	"discord",
	"notion",
	"github",
	"obsidian",
	"googledrive",
];
