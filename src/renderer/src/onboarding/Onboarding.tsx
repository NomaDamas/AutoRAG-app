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
	type ChangeEvent,
	type ReactElement,
} from "react";
import type {
	AccountMethod,
	ByokProviderId,
	DetectedModelProvider,
	DetectedSource,
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
	SourceId,
} from "../../../shared/onboarding-contract";
import { useTranslation } from "../../../shared/i18n";
import { cn } from "../lib/cn";
import { buildFlow, canAdvance, draftDescription, primaryLabelKey, type Translate } from "./flow";
import { Icon } from "./marks";
import type { OnboardingCtx, OverlayKind } from "./context";
import { IndexingScreen } from "./IndexingScreen";
import { AccountStep } from "./steps/Account";
import { EmbeddingStep } from "./steps/Embedding";
import { FoldersStep } from "./steps/Folders";
import { ModelStep } from "./steps/Model";
import { PermissionsStep } from "./steps/Permissions";
import { PlanStep } from "./steps/Plan";
import { SourcesStep } from "./steps/Sources";
import { WelcomeStep } from "./steps/Welcome";

const autorag = window.autorag;
const bridge = autorag.onboarding;

/** The prototype seeds this window title; the real window keeps the same label. */
const WINDOW_TITLE = "AutoRAG";

const TOAST_MS = 2400;
const SAVE_DEBOUNCE_MS = 300;

/** Cloud embedding is unavailable (corpus text never leaves the machine). */
const EMBED = "local" as const;

function seedDraft(candidates: readonly FolderCandidate[], permissions: PermissionStatus | null): OnboardingDraft {
	return {
		version: 1,
		stepId: "welcome",
		account: null,
		notifications: false,
		network: false,
		launchAtLogin: permissions?.launchAtLogin ?? true,
		folders: candidates.map((candidate) => ({ path: candidate.path, selected: candidate.defaultSelected })),
		sources: [],
		plan: "pro",
		planConfirmed: false,
		paid: null,
		model: null,
	};
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
	const [models, setModels] = useState<readonly DetectedModelProvider[]>([]);
	const [modelKey, setModelKey] = useState("");
	const [modelOptions, setModelOptions] = useState<readonly ModelOption[]>([]);
	const [verifying, setVerifying] = useState(false);
	const [modelError, setModelError] = useState<string | null>(null);
	const [overlay, setOverlay] = useState<OverlayKind | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const [tipIndex, setTipIndex] = useState(0);
	const [authBusy, setAuthBusy] = useState(false);
	const [payAgree, setPayAgree] = useState(false);
	const [indexStatus, setIndexStatus] = useState<IndexingStatus | null>(null);
	const [card, setCard] = useState({ number: "", expiry: "", cvc: "" });

	const draftRef = useRef<OnboardingDraft | null>(null);
	const permissionRef = useRef<PermissionStatus | null>(null);
	const modelKeyRef = useRef("");
	const overlayRef = useRef<OverlayKind | null>(null);
	const toastTimer = useRef<number | null>(null);
	const saveTimer = useRef<number | null>(null);
	const scannedRef = useRef(new Set<string>());
	const sourcesRef = useRef(false);
	const embeddingRef = useRef(false);
	const modelsRef = useRef(false);
	const indexingRef = useRef(false);
	const variantRef = useRef(new Map<SourceId, number>());

	// Synced during render, not in an effect: deferred callbacks (the sign-in
	// auto-advance, keyboard handler) must see the state of the latest render.
	draftRef.current = draft;
	permissionRef.current = permission;
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
			setDraft(draft);
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
			void bridge.save(pending);
		}, SAVE_DEBOUNCE_MS);
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
		return canAdvance({
			stepId: current.stepId,
			platform: status?.platform ?? "",
			fullDiskAccess: status?.fullDiskAccess === true,
			signedIn: current.account !== null,
			selectedFolders: current.folders.filter((folder) => folder.selected).length,
			embed: EMBED,
			cloudConsent: false,
			plan: current.plan,
			modelVerified: current.model?.verified === true,
		});
	}, []);

	const flow = draft === null ? [] : buildFlow(draft.plan, draft.planConfirmed, EMBED);

	const startIndexing = useCallback((): void => {
		const current = draftRef.current;
		if (current === null) {
			return;
		}
		const request: IndexingRequest = {
			folders: current.folders.filter((folder) => folder.selected).map((folder) => folder.path),
			sources: current.sources.filter((source) => source.on).map((source) => ({ id: source.id, description: source.description })),
			plan: current.plan,
			model:
				current.plan === "byok" && current.model !== null
					? { provider: current.model.provider, modelId: current.model.modelId, baseUrl: current.model.baseUrl === "" ? null : current.model.baseUrl }
					: null,
		};
		void bridge.startIndexing(request).then((status) => {
			setIndexStatus(status);
		});
	}, []);

	const next = useCallback((): void => {
		const current = draftRef.current;
		if (current === null || !currentAdvance()) {
			return;
		}
		if (current.stepId === "plan" && (current.plan === "air" || current.plan === "pro") && current.paid !== current.plan) {
			setPayAgree(false);
			setOverlay("pay");
			return;
		}
		const list = buildFlow(current.plan, current.planConfirmed, EMBED);
		const target = list[list.indexOf(current.stepId) + 1];
		setDraft({
			...current,
			...(current.stepId === "plan" ? { planConfirmed: true } : {}),
			...(target === undefined ? {} : { stepId: target }),
		});
	}, [currentAdvance]);

	const back = useCallback((): void => {
		const current = draftRef.current;
		if (current === null) {
			return;
		}
		const list = buildFlow(current.plan, current.planConfirmed, EMBED);
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
		void bridge.complete().then(onComplete);
	}, [onComplete, showToast, t]);

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

	// Pre-scan every candidate on the folders step; on a resume past it, still
	// scan the selected folders so later steps' totals and ETA are real.
	useEffect(() => {
		if (stepId === "welcome" || stepId === "permissions" || stepId === "account") {
			return;
		}
		const wanted =
			stepId === "folders"
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

	useEffect(() => {
		if (stepId !== "sources" || sourcesRef.current) {
			return;
		}
		sourcesRef.current = true;
		void bridge.detectSources().then((detection) => {
			setDetectedSources(detection.sources);
			setDraft((current) => {
				if (current === null) {
					return current;
				}
				const merged = detection.sources.map((detected) => {
					const existing = current.sources.find((source) => source.id === detected.id);
					return (
						existing ?? { id: detected.id, on: false, description: draftDescription(detected.id, detected.facts, 0, t) }
					);
				});
				return { ...current, sources: merged };
			});
		});
	}, [stepId, t]);

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

	const sourceFacts = useCallback((id: SourceId) => detectedSources.find((source) => source.id === id)?.facts ?? {}, [detectedSources]);

	const signIn = useCallback(
		(method: AccountMethod, email?: string): void => {
			setAuthBusy(true);
			const delay = method === "email" ? 1100 : 900;
			window.setTimeout(() => {
				setAuthBusy(false);
				patch({ account: { method, email: email !== undefined && email.trim() !== "" ? email.trim() : null } });
				showToast(t("onboarding.toast.signedIn"));
				window.setTimeout(() => {
					if (draftRef.current?.stepId === "account") {
						next();
					}
				}, 700);
			}, delay);
		},
		[next, patch, showToast, t],
	);

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
		models,
		modelKey,
		modelBaseUrl: draft?.model?.baseUrl ?? "",
		modelOptions,
		verifying,
		modelError,
		indexStatus,
		authBusy,
		payAgree,
		tipIndex,
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
		toggleAllFolders: () => {
			const current = draftRef.current;
			if (current === null) {
				return;
			}
			const all = current.folders.length > 0 && current.folders.every((folder) => folder.selected);
			patch({ folders: current.folders.map((folder) => ({ ...folder, selected: !all })) });
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
		setSourceOn: (id, on) =>
			patch({
				sources: (draftRef.current?.sources ?? []).map((source) =>
					source.id === id
						? {
								...source,
								on,
								description:
									on && source.description === "" ? draftDescription(id, sourceFacts(id), 0, t) : source.description,
							}
						: source,
				),
			}),
		setSourceDescription: (id, description) =>
			patch({
				sources: (draftRef.current?.sources ?? []).map((source) => (source.id === id ? { ...source, description } : source)),
			}),
		rewriteSource: (id) => {
			const variant = ((variantRef.current.get(id) ?? 0) + 1) % 3;
			variantRef.current.set(id, variant);
			patch({
				sources: (draftRef.current?.sources ?? []).map((source) =>
					source.id === id ? { ...source, description: draftDescription(id, sourceFacts(id), variant, t) } : source,
				),
			});
		},
		choosePlan: (plan: PlanId) => patch({ plan }),
		signIn,
		signOut: () => patch({ account: null }),
		setLaunchAtLogin: (enabled) => {
			patch({ launchAtLogin: enabled });
			void bridge.setLaunchAtLogin(enabled).then((stored) => patch({ launchAtLogin: stored }));
		},
		requestNotifications: () => {
			void bridge.requestNotifications().then((shown) => {
				if (shown) {
					patch({ notifications: true });
					showToast(t("onboarding.toast.notificationsOn"));
				} else {
					showToast(t("onboarding.toast.notificationsOff"));
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
		setPayAgree,
		confirmPayment: () => {
			const current = draftRef.current;
			if (current === null) {
				return;
			}
			if (!payAgree || card.number.trim() === "" || card.expiry.trim() === "" || card.cvc.trim() === "") {
				showToast(t("onboarding.toast.payMissing"));
				return;
			}
			const list = buildFlow(current.plan, current.planConfirmed, EMBED);
			const target = list[list.indexOf("plan") + 1];
			setCard({ number: "", expiry: "", cvc: "" });
			setOverlay(null);
			setDraft({ ...current, paid: current.plan, ...(target === undefined ? {} : { stepId: target }) });
			showToast(t(current.plan === "pro" ? "onboarding.toast.trialStarted" : "onboarding.toast.subscribed"));
		},
		startIndexing,
		finish,
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
					{t(primaryLabelKey(draft.stepId, draft.plan, draft.paid))} <span className="kbd">↵</span>
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
					payAgree,
					card,
					onCard: setCard,
					onPayAgree: setPayAgree,
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
			<Icon name="folder-search" size={31} />
		</span>
	);
}

interface OverlayHandlers {
	readonly t: Translate;
	readonly ctx: OnboardingCtx;
	readonly payAgree: boolean;
	readonly card: { readonly number: string; readonly expiry: string; readonly cvc: string };
	readonly onCard: (value: { number: string; expiry: string; cvc: string }) => void;
	readonly onPayAgree: (value: boolean) => void;
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
										<strong>AutoRAG</strong>
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
						<Icon name="sparkles" size={21} />
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
		case "why":
			return (
				<div className="modal system-alert">
					<div className="app-mark" style={{ margin: "0 auto 10px" }}>
						<Icon name="shield-check" size={28} />
					</div>
					<h3>{t("onboarding.overlay.why.title")}</h3>
					<p>{t("onboarding.overlay.why.lead")}</p>
					<div className="modal-actions">
						<button type="button" className="primary" onClick={h.onClose}>
							{t("onboarding.overlay.why.ok")}
						</button>
					</div>
				</div>
			);
		case "pay": {
			const pro = h.ctx.draft.plan === "pro";
			const onField = (key: "number" | "expiry" | "cvc") => (event: ChangeEvent<HTMLInputElement>) =>
				h.onCard({ ...h.card, [key]: event.target.value });
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
						<p className="pay-lead">{pro ? t("onboarding.overlay.pay.proLead") : t("onboarding.overlay.pay.airLead")}</p>
						<div className="pay-summary">
							<span>{t("onboarding.overlay.pay.today")}</span>
							<b>{pro ? "$0" : "$4"}</b>
						</div>
						<div className="pay-summary">
							<span>{pro ? t("onboarding.overlay.pay.afterPro") : t("onboarding.overlay.pay.fromNext")}</span>
							<small>{t("onboarding.overlay.pay.monthly", { price: pro ? "$20" : "$4" })}</small>
						</div>
						<div className="pay-grid">
							<label>
								{t("onboarding.overlay.pay.cardNumber")}
								<input
									className="input"
									inputMode="numeric"
									placeholder="4242 4242 4242 4242"
									value={h.card.number}
									onChange={onField("number")}
								/>
							</label>
							<label>
								{t("onboarding.overlay.pay.expiry")}
								<input className="input" placeholder="MM / YY" value={h.card.expiry} onChange={onField("expiry")} />
							</label>
							<label>
								{t("onboarding.overlay.pay.cvc")}
								<input className="input" inputMode="numeric" placeholder="123" value={h.card.cvc} onChange={onField("cvc")} />
							</label>
						</div>
						<label className="consent">
							<input type="checkbox" checked={h.payAgree} onChange={(event) => h.onPayAgree(event.target.checked)} />
							<span>{pro ? t("onboarding.overlay.pay.proConsent") : t("onboarding.overlay.pay.airConsent")}</span>
						</label>
						<p className="pay-demo">{t("onboarding.overlay.pay.demo")}</p>
						<div className="modal-actions">
							<button type="button" className="secondary" onClick={h.onClose}>
								{t("onboarding.overlay.later")}
							</button>
							<button type="button" className="primary" onClick={h.ctx.confirmPayment}>
								{pro ? t("onboarding.overlay.pay.startTrial") : t("onboarding.overlay.pay.payAir")}
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
