/**
 * What an error box says and offers, derived from the message itself. Pure, so
 * every place that shows a run's error reads it the same way.
 *
 * The rule behind the buttons: a model problem (no model, a rejected key, a
 * spent plan, a retired model) can only be cured in Settings, and the AI is
 * the thing that is down, so those errors say so plainly and lead to the page
 * that helps; anything else is the app's own setup, which the fix agent may
 * repair, so that error carries "AI로 고치기".
 */

import type { TFunction } from "i18next";
import { classifyAppError, type AppErrorKind } from "../../../shared/app-error";
import type { LocaleKey } from "../../../shared/i18n";
import type { SearchErrorAction } from "../../../shared/search-contract";

/** `fix` runs the fix agent; the other two go to a Settings page. */
export type ErrorActionId = "fix" | "open-ai" | "open-plan";

export interface ErrorAction {
	readonly id: ErrorActionId;
	/** Already translated: the button's text. */
	readonly label: string;
	/** The accent button; at most one per error. */
	readonly primary: boolean;
}

export interface AppErrorView {
	readonly kind: AppErrorKind;
	/** The plain-words headline; `null` when the message itself already says it (the main process wrote it). */
	readonly title: string | null;
	/** What to do next; `null` when there is nothing to add. */
	readonly hint: string | null;
	readonly actions: readonly ErrorAction[];
}

interface Copy {
	readonly title: LocaleKey;
	readonly hint: LocaleKey;
}

const COPY: Readonly<Record<AppErrorKind, Copy>> = {
	"model-missing": { title: "appError.modelMissing.title", hint: "appError.modelMissing.hint" },
	"model-credentials": { title: "appError.modelCredentials.title", hint: "appError.modelCredentials.hint" },
	"model-subscription": { title: "appError.modelSubscription.title", hint: "appError.modelSubscription.hint" },
	"model-not-found": { title: "appError.modelNotFound.title", hint: "appError.modelNotFound.hint" },
	"rate-limit": { title: "appError.rateLimit.title", hint: "appError.rateLimit.hint" },
	network: { title: "appError.network.title", hint: "appError.network.hint" },
	other: { title: "appError.other.title", hint: "appError.other.hint" },
};

/** The buttons of each kind, in order, and which one leads. */
const PLAN: Readonly<Record<AppErrorKind, readonly (readonly [ErrorActionId, boolean])[]>> = {
	"model-missing": [["open-ai", true]],
	"model-credentials": [
		["open-ai", true],
		["open-plan", false],
	],
	"model-subscription": [
		["open-plan", true],
		["open-ai", false],
	],
	"model-not-found": [["open-ai", true]],
	// Waiting is the cure for these; the model settings are only the way out when it does not pass.
	"rate-limit": [["open-ai", false]],
	network: [["open-ai", false]],
	other: [["fix", true]],
};

function label(id: ErrorActionId, t: TFunction): string {
	switch (id) {
		case "fix":
			return t("appError.fixAction");
		case "open-ai":
			return t("appError.openModelSettings");
		case "open-plan":
			return t("aiSearch.openPlan");
	}
}

/** `serverAction` is the main process's own verdict (it knows the plan's credits are spent); it outranks the wording. */
export function describeAppError(message: string, serverAction: SearchErrorAction | null, t: TFunction): AppErrorView {
	if (serverAction === "open-plan") {
		return { kind: "model-subscription", title: null, hint: null, actions: [{ id: "open-plan", label: label("open-plan", t), primary: true }] };
	}
	const kind = classifyAppError(message);
	const copy = COPY[kind];
	return {
		kind,
		title: t(copy.title),
		hint: t(copy.hint),
		actions: PLAN[kind].map(([id, primary]) => ({ id, label: label(id, t), primary })),
	};
}
