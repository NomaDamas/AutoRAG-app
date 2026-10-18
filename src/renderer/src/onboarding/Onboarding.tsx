/**
 * The onboarding shell: owns the draft, talks to `window.autorag.onboarding`,
 * and renders the same window chrome, footer, toast, and modal scrim as the
 * prototype. Steps are pure views over a `OnboardingCtx`.
 */

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactElement,
} from "react";
import type { AccountStatus } from "../../../shared/account-contract";
import type {
	ByokProviderId,
	DetectedModelProvider,
	DetectedSource,
	EmbedMode,
	EmbeddingInfo,
	FolderCandidate,
	FolderScan,
	IndexingRequest,
	IndexingStatus,
	ModelOption,
	OnboardingDraft,
	OnboardingStepId,
	PermissionStatus,
	PlanId,
} from "../../../shared/onboarding-contract";
import { APP_FULL_NAME } from "../../../shared/app-info";
import { useTranslation } from "../../../shared/i18n";
import { cn } from "../lib/cn";
import {
	buildFlow,
	bySourceOrder,
	canAdvance,
	canSelectCloudEmbedding,
	errorReportsConsentOnLeaving,
	isPlanSelectable,
	planHeld,
	primaryLabelKey,
	resetFolderSelection,
	resolveEmbed,
	shouldSkipPlanStep,
	usageConsentOnLeaving,
	type Translate,
} from "./flow";
import { AppLogo, Icon } from "./marks";
import type { OnboardingCtx, OverlayKind } from "./context";
import {
	addExclusion as withExclusion,
	indexingExclusions,
	initialSmartRun,
	reduceSmartRun,
	setScopeExcluded,
	setScopeMeasure,
	type AddExclusionStatus,
	type SmartRun,
} from "./smart-scope";
import { IndexingScreen } from "./IndexingScreen";
import { AccountStep } from "./steps/Account";
import { EmbeddingStep } from "./steps/Embedding";
import { FoldersStep } from "./steps/Folders";
import { SmartScanStep } from "./steps/SmartScan";
import { ModelStep } from "./steps/Model";
import { PermissionsStep } from "./steps/Permissions";
import { PlanStep } from "./steps/Plan";
import { SourcesStep } from "./steps/Sources";
import { WelcomeStep } from "./steps/Welcome";

const autorag = window.autorag;
const bridge = autorag.onboarding;

/** The prototype seeds this window title; the real window keeps the same label. */
const WINDOW_TITLE = APP_FULL_NAME;

const TOAST_MS = 2400;
const SAVE_DEBOUNCE_MS = 300;

/** Electron wraps a handler's error as "Error invoking remote method 'x': Error: <message>"; show only the message. */
function ipcMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/u, "");
}

function seedDraft(candidates: readonly FolderCandidate[], permissions: PermissionStatus | null): OnboardingDraft {
	return {
		version: 1,
		stepId: "welcome",
		notifications: false,
		network: false,
		launchAtLogin: permissions?.launchAtLogin ?? true,
		folders: candidates.map((candidate) => ({ path: candidate.path, selected: candidate.defaultSelected })),
		// The prototype's default: semantic search is opt-in.
		embed: "none",
		cloudConsent: false,
		sources: [],
		plan: "pro",
		planConfirmed: false,
		model: null,
	};
}

function reconcileAccountDraft(current: OnboardingDraft, status: AccountStatus | null): OnboardingDraft {
	if (status === null) return current;
	if (status.state !== "signedIn") {
		if (current.embed !== "cloud" && !current.cloudConsent) return current;
		// Cloud is gone with the account; a chosen none or local is never rewritten.
		return { ...current, embed: resolveEmbed(current.embed, false), cloudConsent: false };
	}
	const embed = resolveEmbed(current.embed, true);
	const subPlan = status.account?.plan;
	if (subPlan === "air" || subPlan === "pro") {
		const nextPlan: PlanId = embed === "cloud" ? "pro" : subPlan;
		if (embed === "cloud" && subPlan !== "pro") {
			const nextStepId: OnboardingStepId =
				current.stepId === "sources" || current.stepId === "indexing" ? "plan" : current.stepId;
			if (current.plan === nextPlan && current.stepId === nextStepId && !current.planConfirmed) return current;
			return { ...current, plan: nextPlan, stepId: nextStepId, planConfirmed: false };
		}
		const skipPlan = shouldSkipPlanStep(current.planConfirmed, embed, status);
		const nextStepId: OnboardingStepId =
			current.stepId === "plan" && skipPlan ? (embed === "cloud" ? "sources" : "indexing") : current.stepId;
		const nextConfirmed = current.planConfirmed || (current.stepId === "plan" && skipPlan);
		if (current.plan === nextPlan && current.stepId === nextStepId && current.planConfirmed === nextConfirmed) return current;
		return { ...current, plan: nextPlan, stepId: nextStepId, planConfirmed: nextConfirmed };
	}
	if (subPlan === "free" && embed === "cloud") {
		const nextStepId: OnboardingStepId =
			current.stepId === "sources" || current.stepId === "indexing" ? "plan" : current.stepId;
		if (current.plan === "pro" && current.stepId === nextStepId && !current.planConfirmed) return current;
		return { ...current, plan: "pro", stepId: nextStepId, planConfirmed: false };
	}
	return current;
}

export function Onboarding({ onComplete }: { readonly onComplete: () => void }): ReactElement {
	const { t: translateFn } = useTranslation();
	// The onboarding copy lives under a fixed `onboarding` namespace tree; a loose
	// signature keeps the very large key set from fighting i18next's key typing.
	const t = translateFn as unknown as Translate;

	const [draft, setDraft] = useState<OnboardingDraft | null>(null);
	const [candidates, setCandidates] = useState<readonly FolderCandidate[]>([]);
	const [permission, setPermission] = useState<PermissionStatus | null>(null);
	const [fdaPending, setFdaPending] = useState(false);
	const [scans, setScans] = useState<ReadonlyMap<string, FolderScan>>(new Map());
	const [embedding, setEmbedding] = useState<EmbeddingInfo | null>(null);
	const [detectedSources, setDetectedSources] = useState<readonly DetectedSource[]>([]);
	// Done, not "checking": the step's first frame must already show the checking line,
	// never the empty result that would flash before the probe effect runs.
	const [sourcesDone, setSourcesDone] = useState(false);
	const [models, setModels] = useState<readonly DetectedModelProvider[]>([]);
	const [modelKey, setModelKey] = useState("");
	const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([]);
	const [verifying, setVerifying] = useState(false);
	const [modelError, setModelError] = useState<string | null>(null);
	const [overlay, setOverlay] = useState<OverlayKind | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const [tipIndex, setTipIndex] = useState(0);
	const [account, setAccount] = useState<AccountStatus | null>(null);
	const [paying, setPaying] = useState(false);
	const [indexStatus, setIndexStatus] = useState<IndexingStatus | null>(null);
	const [smartRun, setSmartRun] = useState<SmartRun>(initialSmartRun);
	// Unticked: usage statistics are opt-in (an EU user's consent must be an affirmative act).
	const [shareUsage, setShareUsage] = useState(false);
	// Unticked too: error reports are opt-in, a separate purpose with its own consent.
	const [shareErrors, setShareErrors] = useState(false);

	const draftRef = useRef<OnboardingDraft | null>(null);
	/** The run whose result may still land in the draft; null once it was cancelled or the step was left. */
	const smartRunIdRef = useRef<string | null>(null);
	const smartRunRef = useRef<SmartRun>(initialSmartRun);
	const permissionRef = useRef<PermissionStatus | null>(null);
	const modelKeyRef = useRef("");
	const accountRef = useRef<AccountStatus | null>(null);
	const overlayRef = useRef<OverlayKind | null>(null);
	const toastTimer = useRef<number | null>(null);
	const saveTimer = useRef<number | null>(null);
	const scannedRef = useRef(new Set<string>());
	const sourcesRef = useRef(false);
	const embeddingRef = useRef(false);
	const modelsRef = useRef(false);
	const indexingRef = useRef(false);
	const shareUsageRef = useRef(false);
	const shareErrorsRef = useRef(false);

	// Synced during render, not in an effect: deferred callbacks (the sign-in
	// auto-advance, keyboard handler) must see the state of the latest render.
	draftRef.current = draft;
	smartRunRef.current = smartRun;
	shareUsageRef.current = shareUsage;
	shareErrorsRef.current = shareErrors;
	permissionRef.current = permission;
	accountRef.current = account;
	useEffect(() => {
		modelKeyRef.current = modelKey;
	}, [modelKey]);
	useEffect(() => {
		overlayRef.current = overlay;
	}, [overlay]);

	const showToast = useCallback((message: string): void => {
		if (toastTimer.current !== null) {
			window.clearTimeout(toastTimer.current);
		}
		setToast(message);
		toastTimer.current = window.setTimeout(() => {
			setToast(null);
		}, TOAST_MS);
	}, []);

	// Initial load: the authoritative `pending`, the stored draft, and the
	// folder candidates (which a fresh draft is seeded from).
	useEffect(() => {
		let alive = true;
		void (async () => {
			const [snapshot, perms, folders] = await Promise.all([bridge.load(), bridge.permissions(), bridge.folderCandidates()]);
			if (!alive) {
				return;
			}
			if (!snapshot.pending) {
				onComplete();
				return;
			}
			setPermission(perms);
			const draft = snapshot.draft ?? seedDraft(folders, perms);
			// A resumed draft may hold folders added through the dialog; list them
			// again (they are not built-in candidates) so they stay visible.
			const known = new Set(folders.map((candidate) => candidate.path));
			const added = draft.folders
				.filter((folder) => !known.has(folder.path))
				.map(
					(folder): FolderCandidate => ({
						path: folder.path,
						name: folder.path.split(/[\\/]/u).filter(Boolean).pop() ?? folder.path,
						displayPath: folder.path,
						kind: "custom",
						defaultSelected: true,
						ocrOff: false,
					}),
				);
			setCandidates([...folders, ...added]);
			setDraft(reconcileAccountDraft(draft, accountRef.current));
		})();
		return () => {
			alive = false;
		};
	}, [onComplete]);

	// Live pre-scan + index progress.
	useEffect(() => {
		const offScan = bridge.onScanProgress((scan) => {
			setScans((previous) => new Map(previous).set(scan.path, scan));
		});
		const offIndex = bridge.onIndexProgress((status) => {
			setIndexStatus(status);
		});
		return () => {
			offScan();
			offIndex();
		};
	}, []);

	// The smart-indexing agent streams which folder it is looking at, then one result.
	useEffect(
		() =>
			autorag.smartIndexing.onEvent((event) => {
				setSmartRun((previous) => reduceSmartRun(previous, event));
				if (event.type === "result" && event.runId === smartRunIdRef.current) {
					setDraft((current) => (current === null ? current : { ...current, smartScope: event.exclusions }));
				}
			}),
		[],
	);

	// Persist every change (debounced).
	useEffect(() => {
		if (draft === null) {
			return;
		}
		if (saveTimer.current !== null) {
			window.clearTimeout(saveTimer.current);
		}
		const pending = draft;
		saveTimer.current = window.setTimeout(() => {
			saveTimer.current = null;
			void bridge.save(pending);
		}, SAVE_DEBOUNCE_MS);
		return () => {
			if (saveTimer.current !== null) {
				window.clearTimeout(saveTimer.current);
				saveTimer.current = null;
			}
		};
	}, [draft]);

	const patch = useCallback((value: Partial<OnboardingDraft>): void => {
		setDraft((current) => (current === null ? current : { ...current, ...value }));
	}, []);

	const currentAdvance = useCallback((): boolean => {
		const current = draftRef.current;
		if (current === null) {
			return false;
		}
		const status = permissionRef.current;
		const signedIn = accountRef.current?.state === "signedIn";
		const embed = resolveEmbed(current.embed, signedIn);
		return canAdvance({
			stepId: current.stepId,
			platform: status?.platform ?? "",
			fullDiskAccess: status?.fullDiskAccess === true,
			signedIn,
			selectedFolders: current.folders.filter((folder) => folder.selected).length,
			smartScanning: smartRunRef.current.status === "running",
			embed,
			cloudConsent: current.cloudConsent === true,
			plan: current.plan,
			modelVerified: current.model?.verified === true,
		});
	}, []);

	const currentEmbed = resolveEmbed(draft?.embed, canSelectCloudEmbedding(account));
	const flow =
		draft === null
			? []
			: buildFlow(draft.plan, shouldSkipPlanStep(draft.planConfirmed, currentEmbed, account), currentEmbed);

	const startIndexing = useCallback((): void => {
		const current = draftRef.current;
		if (current === null) {
			return;
		}
		const signedIn = accountRef.current?.state === "signedIn";
		const embed = resolveEmbed(current.embed, signedIn);
		const selectedFolders = current.folders.filter((folder) => folder.selected).map((folder) => folder.path);
		const { excludePaths, excludedFiles } = indexingExclusions(current.smartScope, selectedFolders);
		const request: IndexingRequest = {
			folders: selectedFolders,
			embed,
			sources: current.sources.filter((source) => source.on).map((source) => ({ id: source.id })),
			plan: current.plan,
			model:
				current.plan === "byok" && current.model !== null
					? { provider: current.model.provider, modelId: current.model.modelId, baseUrl: current.model.baseUrl === "" ? null : current.model.baseUrl }
					: null,
			...(excludePaths.length > 0 ? { excludePaths, excludedFiles } : {}),
		};
		void bridge.startIndexing(request).then((status) => {
			setIndexStatus(status);
		});
	}, []);

	const refreshAccount = useCallback((): void => {
		setPaying(true);
		void autorag.account
			.refresh()
			.then(setAccount, (error: unknown) => showToast(ipcMessage(error)))
			.finally(() => setPaying(false));
	}, [showToast]);

	const openCheckout = useCallback((): void => {
		const plan = draftRef.current?.plan;
		if (plan !== "air" && plan !== "pro") {
			return;
		}
		void autorag.account.checkout(plan).catch((error: unknown) => showToast(ipcMessage(error)));
	}, [showToast]);

	const next = useCallback((): void => {
		const current = draftRef.current;
		if (current === null || !currentAdvance()) {
			return;
		}
		if (current.stepId === "plan" && (current.plan === "air" || current.plan === "pro") && !planHeld(current.plan, accountRef.current)) {
			if (overlayRef.current !== "pay") {
				openCheckout();
			}
			setOverlay("pay");
			return;
		}
		const signedIn = accountRef.current?.state === "signedIn";
		const embed = resolveEmbed(current.embed, signedIn);
		const list = buildFlow(current.plan, shouldSkipPlanStep(current.planConfirmed, embed, accountRef.current), embed);
		const target = list[list.indexOf(current.stepId) + 1];
		const consent = usageConsentOnLeaving(current.stepId, shareUsageRef.current);
		const errorConsent = errorReportsConsentOnLeaving(current.stepId, shareErrorsRef.current);
		if (consent !== null && errorConsent !== null) {
			// A failed save leaves both settings at their default (off): the safe direction.
			void autorag.settings.set({ usageAnalytics: consent, errorReporting: errorConsent }).catch((error: unknown) => console.error("[onboarding] privacy choices not saved:", error));
		}
		setDraft({
			...current,
			...(current.stepId === "plan" ? { planConfirmed: true } : {}),
			...(target === undefined ? {} : { stepId: target }),
		});
	}, [currentAdvance, openCheckout]);

	const back = useCallback((): void => {
		const current = draftRef.current;
		if (current === null) {
			return;
		}
		const signedIn = accountRef.current?.state === "signedIn";
		const embed = resolveEmbed(current.embed, signedIn);
		const list = buildFlow(current.plan, shouldSkipPlanStep(current.planConfirmed, embed, accountRef.current), embed);
		const index = list.indexOf(current.stepId);
		if (index > 0) {
			const target = list[index - 1];
			if (target !== undefined) {
				setDraft({ ...current, stepId: target });
			}
		}
	}, []);

	const indexStatusRef = useRef<IndexingStatus | null>(null);
	useEffect(() => {
		indexStatusRef.current = indexStatus;
	}, [indexStatus]);

	const finish = useCallback((): void => {
		if (indexStatusRef.current?.state !== "success") {
			showToast(t("onboarding.toast.notIndexed"));
			return;
		}
		if (saveTimer.current !== null) {
			window.clearTimeout(saveTimer.current);
			saveTimer.current = null;
		}
		void bridge.complete().then(onComplete);
	}, [onComplete, showToast, t]);

	const finishInBackground = useCallback((): void => {
		if (saveTimer.current !== null) {
			window.clearTimeout(saveTimer.current);
			saveTimer.current = null;
		}
		void bridge.complete().then(onComplete);
	}, [onComplete]);

	// Step entry: permissions polling, folder pre-scan, connector/model detection.
	const stepId = draft?.stepId ?? "welcome";
	useEffect(() => {
		if (stepId !== "permissions" || (permission?.platform ?? "darwin") === "win32" || permission?.fullDiskAccess === true) {
			return;
		}
		const id = window.setInterval(() => {
			void bridge.permissions().then((status) => {
				setPermission(status);
				if (status.fullDiskAccess) {
					setFdaPending(false);
				}
			});
		}, 2000);
		return () => window.clearInterval(id);
	}, [stepId, permission?.platform, permission?.fullDiskAccess]);

	// Pre-scan every candidate on the smart-scan and folders steps (the folders screen
	// shows each one's size); on a resume past them, still scan the selected folders so
	// later steps' totals and ETA are real.
	useEffect(() => {
		if (stepId === "welcome" || stepId === "permissions" || stepId === "account") {
			return;
		}
		const wanted =
			stepId === "folders" || stepId === "smartScan"
				? candidates.map((candidate) => candidate.path)
				: (draftRef.current?.folders ?? []).filter((folder) => folder.selected).map((folder) => folder.path);
		const missing = wanted.filter((path) => !scannedRef.current.has(path));
		if (missing.length === 0) {
			return;
		}
		for (const path of missing) {
			scannedRef.current.add(path);
		}
		void bridge.scanFolders(missing);
	}, [stepId, candidates]);

	// Leaving the scan screen ends a smart-indexing run still going: its result would arrive after the choices were made.
	useEffect(() => {
		if (stepId === "smartScan" || smartRunIdRef.current === null) {
			return;
		}
		void autorag.smartIndexing.cancel(smartRunIdRef.current);
		smartRunIdRef.current = null;
		setSmartRun(initialSmartRun);
	}, [stepId]);

	const startSmartScan = useCallback((): void => {
		const folders = (draftRef.current?.folders ?? []).filter((folder) => folder.selected).map((folder) => folder.path);
		if (folders.length === 0) {
			return;
		}
		const runId = crypto.randomUUID();
		smartRunIdRef.current = runId;
		setSmartRun({ status: "running", runId, current: null });
		autorag.smartIndexing.analyze(runId, folders).catch((error: unknown) => {
			if (smartRunIdRef.current === runId) {
				setSmartRun({ status: "error", message: ipcMessage(error) });
			}
		});
	}, []);

	// Entering the scan screen starts the analysis of the selected folders once; a draft that already holds proposals
	// (or a run the user cancelled or that failed) is left as it is, with a button to run it again.
	useEffect(() => {
		const current = draftRef.current;
		if (stepId !== "smartScan" || current === null || current.smartScope !== undefined) {
			return;
		}
		if (smartRunRef.current.status !== "idle" || smartRunIdRef.current !== null) {
			return;
		}
		startSmartScan();
	}, [stepId, startSmartScan]);

	// A folder the user left out by hand is measured by the pre-scan; its size lands in the draft when that scan is done.
	useEffect(() => {
		const scope = draft?.smartScope;
		if (scope === undefined) {
			return;
		}
		let next = scope;
		for (const item of scope) {
			const scan = scans.get(item.path);
			if (scan?.done === true && item.reason === "" && (scan.files !== item.files || scan.bytes !== item.bytes)) {
				next = setScopeMeasure(next, item.path, scan.files, scan.bytes);
			}
		}
		if (next !== scope) {
			setDraft((current) => (current === null || current.smartScope === undefined ? current : { ...current, smartScope: next }));
		}
	}, [scans, draft?.smartScope]);

	// The sources step probes every connector in main; each usable one streams in
	// as soon as its own probe finishes, so the list fills row by row.
	useEffect(() => {
		if (stepId !== "sources" || sourcesRef.current) {
			return;
		}
		sourcesRef.current = true;
		const offFound = bridge.onSourceDetected((source) => {
			setDetectedSources((previous) =>
				previous.some((known) => known.id === source.id) ? previous : previous.concat(source).sort(bySourceOrder),
			);
			setDraft((current) => {
				if (current === null || current.sources.some((choice) => choice.id === source.id)) {
					return current;
				}
				return { ...current, sources: current.sources.concat({ id: source.id, on: false }) };
			});
		});
		const offDone = bridge.onSourcesDone(() => setSourcesDone(true));
		void bridge.detectSources().catch(() => setSourcesDone(true));
		return () => {
			offFound();
			offDone();
		};
	}, [stepId]);

	useEffect(() => {
		if (stepId !== "embedding" || embeddingRef.current) {
			return;
		}
		embeddingRef.current = true;
		void bridge.embedding().then(setEmbedding);
	}, [stepId]);

	useEffect(() => {
		if (stepId !== "model" || modelsRef.current) {
			return;
		}
		modelsRef.current = true;
		void bridge.detectModels().then(setModels);
	}, [stepId]);

	useEffect(() => {
		if (stepId === "model" && draft !== null && draft.model === null && draft.plan === "byok") {
			patch({ model: { provider: "anthropic", baseUrl: "", modelId: "", verified: false } });
		}
	}, [stepId, draft, patch]);

	useEffect(() => {
		if (stepId !== "indexing" || indexingRef.current) {
			return;
		}
		indexingRef.current = true;
		startIndexing();
	}, [stepId, startIndexing]);

	// Keyboard: Enter advances, Escape closes an overlay, arrows page the tips.
	const keyboard = useRef({ next, finish, currentAdvance, setTipIndex, overlay: null as OverlayKind | null, stepId });
	keyboard.current = { next, finish, currentAdvance, setTipIndex, overlay, stepId };
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			const active = document.activeElement as HTMLElement | null;
			const tag = active?.tagName;
			const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SELECT";
			if (event.key === "Escape" && keyboard.current.overlay !== null) {
				setOverlay(null);
				return;
			}
			if (event.key === "Enter" && !typing) {
				if (keyboard.current.stepId === "indexing") {
					keyboard.current.finish();
				} else if (keyboard.current.currentAdvance()) {
					keyboard.current.next();
				}
				return;
			}
			if (keyboard.current.stepId === "indexing" && keyboard.current.overlay === null && !typing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
				keyboard.current.setTipIndex((previous) => previous + (event.key === "ArrowRight" ? 1 : -1));
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// The account lives in the main process; this window only mirrors its status.
	useEffect(() => {
		const applyAccount = (status: AccountStatus): void => {
			accountRef.current = status;
			setAccount(status);
			setDraft((current) => (current === null ? current : reconcileAccountDraft(current, status)));
		};
		const off = autorag.account.onChanged(applyAccount);
		void autorag.account.status().then(applyAccount);
		void autorag.account.refresh().then(applyAccount, () => undefined);
		return off;
	}, []);

	// Paying happens in the browser: coming back to this window re-reads the plan.
	useEffect(() => {
		if (overlay !== "pay") {
			return;
		}
		window.addEventListener("focus", refreshAccount);
		return () => window.removeEventListener("focus", refreshAccount);
	}, [overlay, refreshAccount]);

	// The server confirmed the plan the checkout was for: close the overlay and move on.
	useEffect(() => {
		const current = draftRef.current;
		if (overlay !== "pay" || current === null || !planHeld(current.plan, account)) {
			return;
		}
		setOverlay(null);
		showToast(t("onboarding.toast.planActive", { plan: t(`onboarding.plan.plan.${current.plan}.name`) }));
		if (current.stepId === "plan") {
			next();
		}
	}, [overlay, account, next, showToast, t]);

	const signIn = useCallback((): void => {
		void autorag.account.signIn().then(
			(status) => {
				setAccount(status);
				if (status.state === "signedIn") {
					const subPlan = status.account?.plan;
					setDraft((current) => {
						if (current === null) return current;
						const nextPlan: PlanId =
							subPlan === "air" || subPlan === "pro"
								? current.embed === "cloud"
									? "pro"
									: subPlan
								: current.plan === "byok"
									? "pro"
									: current.plan;
						return { ...current, plan: nextPlan };
					});
					showToast(t("onboarding.toast.signedIn"));
					window.setTimeout(() => {
						if (draftRef.current?.stepId === "account") {
							next();
						}
					}, 700);
				} else if (status.error !== null) {
					showToast(status.error);
				}
			},
			(error: unknown) => showToast(ipcMessage(error) || t("onboarding.toast.signInFailed")),
		);
	}, [next, showToast, t]);

	const ctx: OnboardingCtx = {
		draft: draft as OnboardingDraft,
		platform: permission?.platform ?? "darwin",
		permissions: permission,
		fdaPending,
		scanning: candidates.some((candidate) => {
			const scan = scans.get(candidate.path);
			return draft?.folders.some((folder) => folder.path === candidate.path && folder.selected) === true && (scan === undefined || !scan.done);
		}),
		scans,
		candidates,
		embedding,
		sources: detectedSources,
		sourcesChecking: !sourcesDone,
		models,
		modelKey,
		modelBaseUrl: draft?.model?.baseUrl ?? "",
		modelOptions,
		verifying,
		modelError,
		indexStatus,
		account,
		paying,
		tipIndex,
		shareUsage,
		setShareUsage,
		shareErrors,
		setShareErrors,
		t,
		patch,
		setStep: (id: OnboardingStepId) => patch({ stepId: id }),
		next,
		back,
		toast: showToast,
		openOverlay: setOverlay,
		closeOverlay: () => setOverlay(null),
		setFolderSelected: (path, selected) =>
			patch({
				folders: (draftRef.current?.folders ?? []).map((folder) => (folder.path === path ? { ...folder, selected } : folder)),
			}),
		resetFolders: () => {
			const current = draftRef.current;
			if (current !== null) {
				patch({ folders: resetFolderSelection(candidates, current.folders) });
			}
		},
		smartRun,
		startSmartScan,
		cancelSmartScan: () => {
			const runId = smartRunIdRef.current;
			smartRunIdRef.current = null;
			setSmartRun(initialSmartRun);
			if (runId !== null) {
				void autorag.smartIndexing.cancel(runId);
			}
		},
		rescanSmart: () => {
			const runId = smartRunIdRef.current;
			smartRunIdRef.current = null;
			setSmartRun(initialSmartRun);
			if (runId !== null) {
				void autorag.smartIndexing.cancel(runId);
			}
			setDraft((current) => {
				if (current === null) {
					return current;
				}
				const { smartScope: _dropped, ...rest } = current;
				return { ...rest, stepId: "smartScan" };
			});
		},
		setSmartExcluded: (path, excluded) =>
			setDraft((current) =>
				current === null || current.smartScope === undefined ? current : { ...current, smartScope: setScopeExcluded(current.smartScope, path, excluded) },
			),
		addExclusion: () => {
			void bridge.pickFolders().then((picked) => {
				const current = draftRef.current;
				if (current === null || picked.length === 0) {
					return;
				}
				const roots = current.folders.filter((folder) => folder.selected).map((folder) => folder.path);
				let scope = current.smartScope;
				const added: string[] = [];
				let refused: AddExclusionStatus | null = null;
				for (const candidate of picked) {
					const result = withExclusion(scope, candidate.path, roots);
					if (result.status === "added") {
						scope = result.scope;
						added.push(candidate.path);
					} else {
						refused = result.status;
					}
				}
				if (added.length > 0) {
					patch({ smartScope: scope ?? [] });
					void bridge.scanFolders(added);
				} else if (refused !== null) {
					showToast(t(`onboarding.folders.exclude.refused.${refused}`));
				}
			});
		},
		addFolders: () => {
			void bridge.pickFolders().then((picked) => {
				if (picked.length === 0) {
					return;
				}
				setCandidates((previous) => {
					const known = new Set(previous.map((candidate) => candidate.path));
					return previous.concat(picked.filter((candidate) => !known.has(candidate.path)));
				});
				setDraft((current) => {
					if (current === null) {
						return current;
					}
					const known = new Set(current.folders.map((folder) => folder.path));
					return {
						...current,
						folders: current.folders.concat(
							picked.filter((candidate) => !known.has(candidate.path)).map((candidate) => ({ path: candidate.path, selected: true })),
						),
					};
				});
				const added = picked.map((candidate) => candidate.path).filter((path) => !scannedRef.current.has(path));
				for (const path of added) {
					scannedRef.current.add(path);
				}
				if (added.length > 0) {
					void bridge.scanFolders(added);
				}
			});
		},
		setEmbedMode: (embed: EmbedMode) => {
			if (embed === "cloud" && !canSelectCloudEmbedding(accountRef.current)) {
				return;
			}
			setDraft((current) => {
				if (current === null) return current;
				const subPlan = accountRef.current?.state === "signedIn" ? accountRef.current.account?.plan : undefined;
				const nextPlan: PlanId =
					embed === "cloud"
						? "pro"
						: subPlan === "air" || subPlan === "pro"
							? subPlan
							: current.plan;
				return {
					...current,
					embed,
					cloudConsent: false,
					plan: nextPlan,
					planConfirmed: false,
				};
			});
		},
		setCloudConsent: (cloudConsent: boolean) => patch({ cloudConsent }),
		setSourceOn: (id, on) =>
			patch({
				sources: (draftRef.current?.sources ?? []).map((source) => (source.id === id ? { ...source, on } : source)),
			}),
		choosePlan: (plan: PlanId) => {
			const current = draftRef.current;
			const embed = resolveEmbed(current?.embed, canSelectCloudEmbedding(accountRef.current));
			if (!isPlanSelectable(plan, embed)) {
				return;
			}
			patch({ plan });
		},
		signIn,
		cancelSignIn: () => {
			void autorag.account.cancelSignIn().then(setAccount);
		},
		signOut: () => {
			void autorag.account.signOut().then((status) => {
				setAccount(status);
				patch({ embed: resolveEmbed(draftRef.current?.embed, false), cloudConsent: false });
			});
		},
		skipAccount: () => {
			const current = draftRef.current;
			if (current === null) {
				return;
			}
			// BYOK cannot use the cloud embedder, so cloud falls back; a chosen mode stays.
			const embed = resolveEmbed(current.embed, false);
			const list = buildFlow("byok", current.planConfirmed, embed);
			const target = list[list.indexOf(current.stepId) + 1];
			setDraft({ ...current, embed, cloudConsent: false, plan: "byok", ...(target === undefined ? {} : { stepId: target }) });
		},
		openCheckout,
		refreshAccount,
		setLaunchAtLogin: (enabled) => {
			patch({ launchAtLogin: enabled });
			void bridge.setLaunchAtLogin(enabled).then((stored) => {
				patch({ launchAtLogin: stored });
				// The OS can refuse (or the user can remove the item in Login Items); say so
				// instead of leaving the switch looking like it took.
				if (stored !== enabled) {
					showToast(t("onboarding.toast.loginFailed"));
				}
			});
		},
		requestNotifications: () => {
			void bridge.requestNotifications().then((shown) => {
				if (shown) {
					patch({ notifications: true });
					showToast(t("onboarding.toast.notificationsOn"));
				} else {
					// A refused or never-granted permission can only be fixed in System
					// Settings, so open it rather than only saying no.
					showToast(t("onboarding.toast.notificationsOff"));
					void bridge.openNotificationSettings();
				}
			});
		},
		openNotificationSettings: () => {
			void bridge.openNotificationSettings();
		},
		checkNetwork: () => {
			void bridge.checkNetwork().then((result) => {
				if (result.ok) {
					patch({ network: true });
					showToast(t("onboarding.toast.networkOk"));
				} else {
					showToast(t("onboarding.toast.networkFail"));
				}
			});
		},
		setModelProvider: (provider: ByokProviderId) => {
			setModelError(null);
			setModelOptions([]);
			patch({
				model: { provider, baseUrl: draftRef.current?.model?.baseUrl ?? "", modelId: "", verified: false },
			});
		},
		setModelKey,
		setModelBaseUrl: (value) =>
			patch({
				model: {
					provider: draftRef.current?.model?.provider ?? "anthropic",
					baseUrl: value,
					modelId: draftRef.current?.model?.modelId ?? "",
					verified: draftRef.current?.model?.verified ?? false,
				},
			}),
		verifyModel: (providerOverride) => {
			const current = draftRef.current;
			const provider = providerOverride ?? current?.model?.provider ?? "anthropic";
			setVerifying(true);
			setModelError(null);
			void bridge
				.verifyModel({
					provider,
					apiKey: modelKeyRef.current === "" ? null : modelKeyRef.current,
					baseUrl: provider === "openai-compatible" ? (current?.model?.baseUrl ?? null) : null,
				})
				.then((result) => {
					setVerifying(false);
					if (result.ok) {
						setModelOptions(result.models);
						patch({
							model: { provider, baseUrl: current?.model?.baseUrl ?? "", modelId: result.recommended, verified: true },
						});
						showToast(t("onboarding.toast.verified"));
					} else {
						setModelError(result.error);
					}
				})
				.catch((error: unknown) => {
					setVerifying(false);
					setModelError(error instanceof Error ? error.message : String(error));
				});
		},
		startIndexing,
		finish,
		finishInBackground,
		setTipIndex,
		dragApp: () => bridge.dragApp(),
		relaunch: () => {
			// The debounced save may still be pending; persist first so the relaunch
			// resumes with the latest draft (the step and every toggle).
			if (saveTimer.current !== null) {
				window.clearTimeout(saveTimer.current);
				saveTimer.current = null;
			}
			const current = draftRef.current;
			void (current === null ? Promise.resolve() : bridge.save(current)).then(() => bridge.relaunch());
		},
		openFullDiskAccess: () => {
			void bridge.openFullDiskAccess();
			setOverlay("fda");
		},
	};

	if (draft === null) {
		return <div className="onb" />;
	}

	const renderStep = (): ReactElement => {
		switch (draft.stepId) {
			case "welcome":
				return <WelcomeStep ctx={ctx} />;
			case "permissions":
				return <PermissionsStep ctx={ctx} />;
			case "account":
				return <AccountStep ctx={ctx} />;
			case "smartScan":
				return <SmartScanStep ctx={ctx} />;
			case "folders":
				return <FoldersStep ctx={ctx} />;
			case "embedding":
				return <EmbeddingStep ctx={ctx} />;
			case "sources":
				return <SourcesStep ctx={ctx} />;
			case "plan":
				return <PlanStep ctx={ctx} />;
			case "model":
				return <ModelStep ctx={ctx} />;
			case "indexing":
				return <IndexingScreen ctx={ctx} />;
		}
	};

	const footerIndex = flow.indexOf(draft.stepId);
	const footer =
		draft.stepId === "indexing" ? null : (
			<>
				<button type="button" className="back-btn" disabled={footerIndex <= 0} onClick={back}>
					<Icon name="chevron-left" size={15} />
				</button>
				<div className="progress-dashes">
					{flow.map((id, index) => (
						<span
							key={id}
							className={cn("dash", index < footerIndex && "done", index === footerIndex && "active")}
							title={t(`onboarding.step.${id}`)}
						/>
					))}
				</div>
				<button type="button" className="primary" disabled={!currentAdvance()} onClick={next}>
					{t(primaryLabelKey(draft.stepId, draft.plan, planHeld(draft.plan, account)))} <span className="kbd">↵</span>
				</button>
			</>
		);

	return (
		<div className={cn("onb", draft.stepId === "indexing" && "immersive")}>
			<header className="titlebar">
				<div className="window-title">{WINDOW_TITLE}</div>
			</header>
			<div className="stage">{renderStep()}</div>
			<footer className="footer">{footer}</footer>
			<div className={cn("toast", toast !== null && "show")}>{toast}</div>
			<div className="scrim" hidden={overlay === null}>
				{renderOverlay(overlay, {
					t,
					ctx,
					onClose: () => setOverlay(null),
					onFdaAllowed: () => {
						void bridge.permissions().then((status) => {
							setPermission(status);
							if (status.fullDiskAccess) {
								setOverlay("restart");
							} else {
								setFdaPending(true);
								setOverlay(null);
								showToast(t("onboarding.toast.fdaPending"));
							}
						});
					},
					onFdaLater: () => {
						setFdaPending(true);
						setOverlay(null);
						showToast(t("onboarding.toast.fdaPending"));
					},
				})}
			</div>
		</div>
	);
}

/** The app-mark the Full Disk Access guide's drag target uses (the prototype's `appIcon()`). */
function GuideAppMark({ onDrag }: { readonly onDrag: () => void }): ReactElement {
	return (
		<span className="app-mark" draggable onDragStart={onDrag} style={{ cursor: "grab" }}>
			<AppLogo />
		</span>
	);
}

interface OverlayHandlers {
	readonly t: Translate;
	readonly ctx: OnboardingCtx;
	readonly onClose: () => void;
	readonly onFdaAllowed: () => void;
	readonly onFdaLater: () => void;
}

function renderOverlay(kind: OverlayKind | null, h: OverlayHandlers): ReactElement | null {
	const { t } = h;
	switch (kind) {
		case "fda":
			return (
				<div className="modal">
					<div className="modal-head">
						<Icon name="settings" size={15} />
						<strong>{t("onboarding.overlay.fda.title")}</strong>
						<button type="button" className="quiet" onClick={h.onClose}>
							<Icon name="x" size={15} />
						</button>
					</div>
					<div className="modal-body">
						<div className="guide">
							<div className="guide-copy">
								<h3>{t("onboarding.overlay.fda.heading")}</h3>
								<p>{t("onboarding.overlay.fda.lead")}</p>
								<div className="guide-steps">
									<div className="guide-step">
										<b>1</b>
										<span>{t("onboarding.overlay.fda.step1")}</span>
									</div>
									<div className="guide-step">
										<b>2</b>
										<span>{t("onboarding.overlay.fda.step2")}</span>
									</div>
									<div className="guide-step">
										<b>3</b>
										<span>{t("onboarding.overlay.fda.step3")}</span>
									</div>
								</div>
								<div className="guide-app">
									<GuideAppMark onDrag={h.ctx.dragApp} />
									<span>{t("onboarding.overlay.fda.drag")}</span>
								</div>
							</div>
							<div className="settings-mock">
								<div className="settings-nav">
									<strong>{t("onboarding.overlay.fda.mock.navTitle")}</strong>
									<div>{t("onboarding.overlay.fda.mock.notifications")}</div>
									<div>{t("onboarding.overlay.fda.mock.files")}</div>
									<div className="active">{t("onboarding.overlay.fda.mock.fda")}</div>
									<div>{t("onboarding.overlay.fda.mock.automation")}</div>
								</div>
								<div className="settings-pane">
									<h3>{t("onboarding.overlay.fda.mock.fda")}</h3>
									<p>{t("onboarding.overlay.fda.mock.paneLead")}</p>
									<div className="system-row">
										<span className="system-app">⌘</span>
										<strong>Terminal</strong>
										<span className="system-toggle on" />
									</div>
									<div className="system-row">
										<span className="system-app">VS</span>
										<strong>Visual Studio Code</strong>
										<span className="system-toggle" />
									</div>
									<div className="system-row target">
										<span className="system-app">
											<Icon name="sparkles" size={13} />
										</span>
										<strong>Dazzi</strong>
										<button
											type="button"
											className={cn("system-toggle", h.ctx.permissions?.fullDiskAccess === true && "on pulse")}
											onClick={() => h.ctx.openOverlay("restart")}
										/>
									</div>
									<div className="system-row">
										<span className="system-app">↗</span>
										<strong>Backup</strong>
										<span className="system-toggle" />
									</div>
								</div>
							</div>
						</div>
						<div className="modal-actions">
							<button type="button" className="secondary" onClick={h.onFdaLater}>
								{t("onboarding.overlay.later")}
							</button>
							<button type="button" className="primary" onClick={h.onFdaAllowed}>
								{t("onboarding.overlay.fda.allowed")}
							</button>
						</div>
					</div>
				</div>
			);
		case "restart":
			return (
				<div className="modal system-alert">
					<div className="app-mini">
						<AppLogo />
					</div>
					<h3>{t("onboarding.overlay.restart.title")}</h3>
					<p>{t("onboarding.overlay.restart.lead")}</p>
					<div className="modal-actions">
						<button type="button" className="secondary" onClick={h.onFdaLater}>
							{t("onboarding.overlay.later")}
						</button>
						<button type="button" className="primary" onClick={() => void h.ctx.relaunch()}>
							{t("onboarding.overlay.restart.action")}
						</button>
					</div>
				</div>
			);
		case "pay": {
			const pro = h.ctx.draft.plan === "pro";
			return (
				<div className="modal" style={{ width: 460 }}>
					<div className="modal-head">
						<Icon name="key-round" size={15} />
						<strong>{pro ? t("onboarding.overlay.pay.proTitle") : t("onboarding.overlay.pay.airTitle")}</strong>
						<button type="button" className="quiet" onClick={h.onClose}>
							<Icon name="x" size={15} />
						</button>
					</div>
					<div className="modal-body">
						<p className="pay-lead">{t("onboarding.overlay.pay.lead")}</p>
						<div className="pay-summary">
							<span>{t(`onboarding.plan.plan.${pro ? "pro" : "air"}.name`)}</span>
							<small>{t(`onboarding.plan.plan.${pro ? "pro" : "air"}.note`)}</small>
						</div>
						<p className="pay-demo">{t("onboarding.overlay.pay.waiting")}</p>
						<div className="modal-actions">
							<button type="button" className="secondary" onClick={h.onClose}>
								{t("onboarding.overlay.later")}
							</button>
							<button type="button" className="secondary" onClick={h.ctx.openCheckout}>
								{t("onboarding.overlay.pay.reopen")}
							</button>
							<button type="button" className="primary" disabled={h.ctx.paying} onClick={h.ctx.refreshAccount}>
								{h.ctx.paying ? t("onboarding.overlay.pay.checking") : t("onboarding.overlay.pay.check")}
							</button>
						</div>
					</div>
				</div>
			);
		}
		default:
			return null;
	}
}
