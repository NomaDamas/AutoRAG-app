/**
 * Pure onboarding logic: the step flow, advance gates, ETA math, folder and
 * source formatting, and the order detected sources are listed in.
 *
 * Everything here is a plain function of its arguments so the flow can be
 * tested without React, Electron, or the bridge. i18n is injected as a
 * `translate` callback so the drafter stays testable and the copy still lives
 * in the locale files.
 */

import type { AccountPlanId, AccountStatus } from "../../../shared/account-contract";
import { isPaidPlanId, planCovers } from "../../../shared/account-contract";
import type {
	EmbedMode,
	FolderScan,
	IndexingPhase,
	OnboardingStepId,
	PlanId,
	SourceFacts,
	SourceId,
} from "../../../shared/onboarding-contract";
import type { LocalSpecVerdict } from "../../../shared/local-embedding-spec";
import { CLOUD_FILES_PER_MINUTE, LOCAL_FILES_PER_MINUTE, NONE_FILES_PER_MINUTE, NONE_MIN_MINUTES } from "../../../shared/onboarding-contract";
import { datasourceSupported } from "../../../shared/messenger-platform";

export type { EmbedMode };

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The prototype's `flow()`: cloud embedding puts the plan step right after
 * embedding; the keyword-only and local modes put it after the sources step.
 * A confirmed plan (or an already active Air/Pro subscription) drops out of the
 * list, and the model and role steps only exist for BYOK.
 *
 * The smart scan runs on the agent's model, so a user who chose BYOK on the
 * account step (not signed in) connects that model right after it, before any
 * folder is scanned. A signed-in user who only picks BYOK on the plan step has
 * already scanned with the account's model; theirs comes after the plan. Someone
 * who brings their own key and skips the Dazzi plan also picks the reranker and
 * Jev, which the plan would otherwise provide, right before the first index.
 */
export function buildFlow(plan: PlanId, planConfirmed: boolean, embed: EmbedMode, signedIn: boolean): OnboardingStepId[] {
	const mid: OnboardingStepId[] = embed === "cloud" ? ["plan", "sources"] : ["sources", "plan"];
	const modelFirst = plan === "byok" && !signedIn;
	const tail: OnboardingStepId[] = plan !== "byok" ? ["indexing"] : modelFirst ? ["roles", "indexing"] : ["model", "roles", "indexing"];
	const head: OnboardingStepId[] = ["welcome", "permissions", "account", ...(modelFirst ? (["model"] as const) : []), "folders", "smartScan", "smartScope", "embedding"];
	return head.concat(planConfirmed ? mid.filter((id) => id !== "plan") : mid).concat(tail);
}

export function stepIndex(flow: readonly OnboardingStepId[], stepId: OnboardingStepId): number {
	return Math.max(0, flow.indexOf(stepId));
}

/** Cloud embedding can be selected on the embedding step as soon as the user is signed in to Dazzi. */
export function canSelectCloudEmbedding(status: AccountStatus | null): boolean {
	return status?.state === "signedIn";
}

/**
 * The mode the flow actually runs with. `cloud` is only usable while the
 * account can select it, so it collapses to the prototype's `fallbackEmbed()`
 * value (`local`) when it cannot. A mode the user chose — `none` or `local` —
 * is never rewritten, and a draft saved before the modes existed (`undefined`)
 * keeps reading as `local`.
 *
 * A machine below the local spec (`localAllowed` false) cannot run local
 * embedding at all, so everything that would have read as `local` reads as the
 * keyword-only `none` instead.
 */
export function resolveEmbed(embed: EmbedMode | undefined, cloudAvailable: boolean, localAllowed = true): EmbedMode {
	const local: EmbedMode = localAllowed ? "local" : "none";
	if (embed === undefined || embed === "local") return local;
	return embed === "none" ? "none" : cloudAvailable ? "cloud" : local;
}

/** Whether the local card may be chosen: false below the spec, and until the machine has been checked. */
export function localEmbeddingAllowed(localSpec: LocalSpecVerdict | null): boolean {
	return localSpec?.eligible === true;
}

/** When cloud embedding is selected, only Pro and Max (which includes everything in Pro) are available on the plan step. */
export function isPlanSelectable(plan: PlanId, embed: EmbedMode): boolean {
	return embed === "cloud" ? plan === "pro" || plan === "max" : true;
}

/** The plan the draft takes when cloud embedding is chosen: Pro, unless the account already holds Max. */
export function cloudPlanFor(held: AccountPlanId | undefined): PlanId {
	return held === "max" ? "max" : "pro";
}

/**
 * Whether the plan step should be skipped in the onboarding flow.
 * Already confirmed, or the signed-in account already holds a paid subscription
 * (any paid plan for local embedding; Pro or Max for cloud embedding).
 */
export function shouldSkipPlanStep(planConfirmed: boolean, embed: EmbedMode, status: AccountStatus | null): boolean {
	if (planConfirmed) return true;
	const activePlan = status?.state === "signedIn" ? status.account?.plan : undefined;
	if (embed === "cloud") return activePlan === "pro" || activePlan === "max";
	return isPaidPlanId(activePlan);
}
export interface AdvanceState {
	readonly stepId: OnboardingStepId;
	readonly platform: string;
	readonly fullDiskAccess: boolean;
	readonly signedIn: boolean;
	readonly selectedFolders: number;
	/** The smart-indexing agent is still looking through the folders. */
	readonly smartScanning: boolean;
	readonly embed: EmbedMode;
	readonly cloudConsent: boolean;
	readonly plan: PlanId;
	/** The promo code typed for the checkout is empty or well-formed, or there is no checkout to send it with. */
	readonly promoValid: boolean;
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
			if (isPaidPlanId(state.plan) && !state.promoValid) return false;
			return state.signedIn || state.plan === "byok";
		case "smartScan":
			// The folders were chosen in the step before; the next screen is where the AI's proposals are reviewed.
			return !state.smartScanning;
		case "folders":
		case "smartScope":
			return state.selectedFolders > 0;
		case "embedding":
			// Only the cloud embedder sends document text anywhere, so only it needs consent.
			return state.embed !== "cloud" || state.cloudConsent;
		case "model":
			return state.plan !== "byok" || state.modelVerified;
		default:
			return true;
	}
}

/**
 * True when the signed-in account's plan already includes `plan`. Free and BYOK
 * need nothing from the account, so only the paid plans can be "held".
 */
export function planHeld(plan: PlanId, status: AccountStatus | null): boolean {
	if (!isPaidPlanId(plan)) return false;
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
	return plan === "pro" ? "onboarding.plan.checkoutPro" : plan === "max" ? "onboarding.plan.checkoutMax" : "onboarding.plan.checkoutAir";
}

/**
 * The value to save for "usage statistics" when the user leaves `stepId`, or
 * null when that step records nothing. Consent is the act of continuing from
 * the step that shows the checkbox (ticked by default there): closing the
 * window there saves nothing, and the stored setting stays at its default (off).
 */
export function usageConsentOnLeaving(stepId: OnboardingStepId, checked: boolean): boolean | null {
	return stepId === "welcome" ? checked : null;
}

/** Same rule for "error reports": the value to save when the user leaves `stepId`, or null. The stored default stays off until then. */
export function errorReportsConsentOnLeaving(stepId: OnboardingStepId, checked: boolean): boolean | null {
	return stepId === "welcome" ? checked : null;
}

/** Files-per-minute ETA the prototype computes with `eta(mode)`. */
export function etaMinutes(files: number, mode: EmbedMode): number {
	if (mode === "none") {
		// Nothing is embedded, but the folder walk and the parse have a fixed cost.
		return Math.max(NONE_MIN_MINUTES, Math.ceil(files / NONE_FILES_PER_MINUTE));
	}
	const rate = mode === "cloud" ? CLOUD_FILES_PER_MINUTE : LOCAL_FILES_PER_MINUTE;
	return Math.max(1, Math.ceil(files / rate));
}

/** How a meter reads: the pip colour, not the value (the prototype's `em-meter.good|warn|bad`). */
export type EmbedTone = "good" | "warn" | "bad";

/** One `em-meter` row: a label, how many of its four pips are lit, and the value word. */
export interface EmbedMeter {
	readonly labelKey: string;
	readonly fill: number;
	readonly valueKey: string;
	readonly tone: EmbedTone;
}

/** The tail of a card's `em-foot`: the local model's download, and whether it is already here. */
export type EmbedFoot = { readonly kind: "size"; readonly bytes: number } | { readonly kind: "cached" } | { readonly kind: "unknown" };

/** One `em-card`: everything it shows, as locale keys and numbers the view renders. */
export interface EmbedCard {
	readonly id: EmbedMode;
	readonly icon: string;
	readonly nameKey: string;
	readonly tag: { readonly labelKey: string; readonly tone: EmbedTone } | null;
	readonly lineKey: string;
	readonly meters: readonly EmbedMeter[];
	readonly minutes: number;
	readonly foot: EmbedFoot | null;
	readonly disabled: boolean;
	/** Set on the card a machine below the spec cannot use; the view says why. */
	readonly blocked: Extract<LocalSpecVerdict, { eligible: false }> | null;
}

export interface EmbedCardsInput {
	readonly files: number;
	readonly platform: string;
	/** Signed in to Dazzi: the only thing the cloud card requires. */
	readonly cloudAvailable: boolean;
	/** Null while the local embedder's size is still unknown. */
	readonly modelBytes: number | null;
	readonly modelCached: boolean;
	/** This machine's verdict for the local model; null until it has been checked. */
	readonly localSpec: LocalSpecVerdict | null;
}

/**
 * The prototype's `embedOptions()`: the three ways to make documents searchable,
 * compared on the same two axes (power needed, accuracy). `none` embeds nothing
 * and is the cheapest; only the cloud card can be unavailable.
 */
export function embedCards(input: EmbedCardsInput): readonly EmbedCard[] {
	const meter = (label: "performance" | "accuracy", fill: number, value: string, tone: EmbedTone): EmbedMeter => ({
		labelKey: `onboarding.embedding.meter.${label}`,
		fill,
		valueKey: `onboarding.embedding.meter.${value}`,
		tone,
	});
	const localDownload: EmbedFoot = input.modelCached
		? { kind: "cached" }
		: input.modelBytes === null
			? { kind: "unknown" }
			: { kind: "size", bytes: input.modelBytes };
	return [
		{
			id: "none",
			icon: "search",
			nameKey: "onboarding.embedding.card.none.name",
			tag: null,
			lineKey: "onboarding.embedding.card.none.line",
			meters: [meter("performance", 1, "low", "good"), meter("accuracy", 2, "meh", "warn")],
			minutes: etaMinutes(input.files, "none"),
			foot: null,
			disabled: false,
			blocked: null,
		},
		{
			id: "local",
			icon: "cpu",
			nameKey: "onboarding.embedding.card.local.name",
			tag: null,
			lineKey: input.platform === "win32" ? "onboarding.embedding.card.local.linePc" : "onboarding.embedding.card.local.lineMac",
			meters: [meter("performance", 4, "high", "warn"), meter("accuracy", 4, "good", "good")],
			minutes: etaMinutes(input.files, "local"),
			foot: localDownload,
			disabled: !localEmbeddingAllowed(input.localSpec),
			blocked: input.localSpec !== null && !input.localSpec.eligible ? input.localSpec : null,
		},
		{
			id: "cloud",
			icon: "cloud",
			nameKey: "onboarding.embedding.card.cloud.name",
			tag: { labelKey: "onboarding.plan.plan.pro.name", tone: "warn" },
			lineKey: "onboarding.embedding.card.cloud.line",
			meters: [meter("performance", 1, "low", "good"), meter("accuracy", 4, "good", "good")],
			minutes: etaMinutes(input.files, "cloud"),
			foot: null,
			disabled: !input.cloudAvailable,
			blocked: null,
		},
	];
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
	// Anything above zero shows as at least 1 KB, so a small folder is not reported as empty.
	return `${bytes <= 0 ? 0 : Math.max(1, Math.round(bytes / 1000))} KB`;
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

/**
 * The indexing phase strip for a run. The embedding phase only exists when
 * something is embedded, so the keyword-only path goes straight from reading
 * documents to finalizing.
 */
export function indexingPhases(embed: EmbedMode): readonly IndexingPhase[] {
	return embed === "none" ? ["parsed", "finalizing"] : ["parsed", "minsync", "finalizing"];
}

/** Phase → position in that run's strip. */
export function phaseIndex(embed: EmbedMode, phase: IndexingPhase): number {
	return Math.max(0, indexingPhases(embed).indexOf(phase));
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

/** "Connect later" chips: every connectable brand the probes did not already find, minus the ones this OS cannot run (KakaoTalk off macOS). */
export function connectableLater(
	detected: readonly { readonly id: SourceId }[],
	platform: string = "darwin",
): readonly { readonly brand: string; readonly label: string }[] {
	const found = new Set<SourceId>(detected.map((source) => source.id));
	return CONNECTABLE_BRANDS.filter(
		(entry) => (entry.sourceId === undefined || !found.has(entry.sourceId)) && (entry.sourceId === undefined || datasourceSupported(entry.sourceId, platform)),
	);
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
