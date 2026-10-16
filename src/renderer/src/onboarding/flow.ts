/**
 * Pure onboarding logic: the step flow, advance gates, ETA math, folder and
 * source formatting, and the order detected sources are listed in.
 *
 * Everything here is a plain function of its arguments so the flow can be
 * tested without React, Electron, or the bridge. i18n is injected as a
 * `translate` callback so the drafter stays testable and the copy still lives
 * in the locale files.
 */

import type { AccountStatus } from "../../../shared/account-contract";
import { planCovers } from "../../../shared/account-contract";
import type {
	EmbedMode,
	FolderScan,
	IndexingPhase,
	OnboardingStepId,
	PlanId,
	SourceFacts,
	SourceId,
} from "../../../shared/onboarding-contract";
import { CLOUD_FILES_PER_MINUTE, LOCAL_FILES_PER_MINUTE } from "../../../shared/onboarding-contract";

export type { EmbedMode };

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The prototype's `flow()`: cloud embedding puts the plan step right after
 * embedding; a confirmed plan (or an already active Air/Pro subscription)
 * drops out of the list, and the model step only exists for BYOK.
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

/** Cloud embedding can be selected on the embedding step as soon as the user is signed in to Dazzi. */
export function canSelectCloudEmbedding(status: AccountStatus | null): boolean {
	return status?.state === "signedIn";
}

/** When cloud embedding is selected, only the Pro plan is available on the plan step. */
export function isPlanSelectable(plan: PlanId, embed: EmbedMode): boolean {
	return embed === "cloud" ? plan === "pro" : true;
}

/**
 * Whether the plan step should be skipped in the onboarding flow.
 * Already confirmed, or the signed-in account already holds a paid subscription
 * (Air or Pro for local embedding; Pro for cloud embedding).
 */
export function shouldSkipPlanStep(planConfirmed: boolean, embed: EmbedMode, status: AccountStatus | null): boolean {
	if (planConfirmed) return true;
	const activePlan = status?.state === "signedIn" ? status.account?.plan : undefined;
	if (embed === "cloud") return activePlan === "pro";
	return activePlan === "air" || activePlan === "pro";
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
			// Skipping the account is the BYOK path: it needs no sign-in.
			return state.signedIn || state.plan === "byok";
		case "plan":
			if (!isPlanSelectable(state.plan, state.embed)) return false;
			return state.signedIn || state.plan === "byok";
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

/**
 * True when the signed-in account's plan already includes `plan`. Free and BYOK
 * need nothing from the account, so only Air and Pro can be "held".
 */
export function planHeld(plan: PlanId, status: AccountStatus | null): boolean {
	if (plan !== "air" && plan !== "pro") return false;
	return status?.state === "signedIn" && status.account !== null && planCovers(status.account.plan, plan);
}

/**
 * The footer primary's label for the step. On the plan step a paid choice the
 * account does not hold yet opens the hosted checkout; once the account's
 * plan covers the choice the step just continues.
 */
export function primaryLabelKey(stepId: OnboardingStepId, plan: PlanId, held: boolean): string {
	if (stepId !== "plan") {
		return `onboarding.stepLabel.${stepId}`;
	}
	if (held || plan === "free" || plan === "byok") {
		return "onboarding.plan.continue";
	}
	return plan === "pro" ? "onboarding.plan.checkoutPro" : "onboarding.plan.checkoutAir";
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
		case "kakao":
			return { brand: "kakaotalk", icon: "message-circle", color: "orange" };
		case "slack":
			return { brand: "slack", icon: "message-circle", color: "purple" };
		case "discord":
			return { brand: "discord", icon: "message-circle", color: "purple" };
		case "telegram":
			return { brand: "telegram", icon: "message-circle", color: "blue" };
		case "whatsapp":
			return { brand: "whatsapp", icon: "message-circle", color: "green" };
		case "mailcrawl":
			return { icon: "mail", color: "red" };
		case "github":
			return { brand: "github", icon: "git-branch", color: "green" };
		case "obsidian":
			return { brand: "obsidian", icon: "notebook-pen", color: "purple" };
	}
}

/** A connector's second line, built from its detected facts. */
export function sourceDetail(id: SourceId, facts: SourceFacts, translate: Translate): string {
	return translate(`onboarding.sources.detail.${id}`, {
		repos: facts.repos?.length ?? 0,
		vaults: facts.vaults?.length ?? 0,
		accounts: facts.accounts?.length ?? 0,
		workspaces: facts.workspaces ?? 0,
		chats: facts.chats ?? 0,
		messages: facts.messages ?? 0,
	});
}

/**
 * The order connectors are listed in: messengers first, then mail, then work tools.
 * Probes finish in whatever order they like, so the list sorts on arrival and a
 * row never jumps because a slower probe landed later.
 */
const SOURCE_LIST_ORDER: readonly SourceId[] = ["kakao", "slack", "discord", "telegram", "whatsapp", "mailcrawl", "github", "obsidian"];

export function bySourceOrder(a: { readonly id: SourceId }, b: { readonly id: SourceId }): number {
	return SOURCE_LIST_ORDER.indexOf(a.id) - SOURCE_LIST_ORDER.indexOf(b.id);
}

/** Phase → position in the indexing phase strip. */
export function phaseIndex(phase: IndexingPhase): number {
	switch (phase) {
		case "parsed":
			return 0;
		case "minsync":
			return 1;
		case "finalizing":
			return 2;
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
	{ kind: "shortcut", mod: true, key: "1" },
	{ kind: "brands" },
	{ kind: "shortcut", mod: true, key: "," },
];

/**
 * Brands the "connect later" row can offer. `sourceId` ties a chip to a detectable
 * connector so it disappears once that connector is found; the rest (Notion, Google
 * Drive) cannot be detected here and are always offered for Settings.
 */
const CONNECTABLE_BRANDS: readonly { readonly brand: string; readonly label: string; readonly sourceId?: SourceId }[] = [
	{ brand: "kakaotalk", label: "KakaoTalk", sourceId: "kakao" },
	{ brand: "slack", label: "Slack", sourceId: "slack" },
	{ brand: "discord", label: "Discord", sourceId: "discord" },
	{ brand: "telegram", label: "Telegram", sourceId: "telegram" },
	{ brand: "whatsapp", label: "WhatsApp", sourceId: "whatsapp" },
	{ brand: "github", label: "GitHub", sourceId: "github" },
	{ brand: "obsidian", label: "Obsidian", sourceId: "obsidian" },
	{ brand: "notion", label: "Notion" },
	{ brand: "googledrive", label: "Google Drive" },
];

/** "Connect later" chips: every connectable brand the probes did not already find. */
export function connectableLater(detected: readonly { readonly id: SourceId }[]): readonly { readonly brand: string; readonly label: string }[] {
	const found = new Set<SourceId>(detected.map((source) => source.id));
	return CONNECTABLE_BRANDS.filter((entry) => entry.sourceId === undefined || !found.has(entry.sourceId));
}

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
