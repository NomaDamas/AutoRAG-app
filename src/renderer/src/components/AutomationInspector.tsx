/**
 * The 자동화 tab's right column: the AI chat, nothing else. A rule's details, its runs and the 새 자동화 card all live
 * in the tab's own column (Figma 621:4556, 621:4882, 621:5262), so this side is where the person asks the AI to make
 * or change an automation; the agent manages the rules with its own tools. Until a conversation starts it shows the
 * faded mark over a line saying so, above the same ask box the file inspector has.
 */

import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AutomationRule } from "../../../shared/automation-contract";
import { RefreshIcon, SparklesIcon, ZapIcon } from "./icons";
import { FadedDazziMark } from "./Inspector";

export interface AutomationInspectorProps {
	/** The ask-anything box at the foot, the same one the file inspector has. */
	readonly chatDock?: ReactNode;
	/** The conversation that box started; it fills the column while it is open. */
	readonly chatView?: ReactNode;
	/** Over the empty state: the chat head, so a past chat can be picked before a new one starts. */
	readonly chatHead?: ReactNode;
}

/** A rule's action as its glyph: the search index refresh, an AI Search run, or any other program. */
export function AutomationActionGlyph({ rule, size = 20 }: { readonly rule: AutomationRule; readonly size?: number }): ReactElement {
	if (rule.agent !== undefined) return <SparklesIcon size={size} />;
	if (rule.run[0] === "autorag" && rule.run[1] === "refresh") return <RefreshIcon size={size} />;
	if (rule.run[0] === "autorag" && rule.run[1] === "search") return <SparklesIcon size={size} />;
	return <ZapIcon size={size} />;
}

export function AutomationInspector({ chatDock, chatView, chatHead }: AutomationInspectorProps): ReactElement {
	const { t } = useTranslation();
	return (
		<aside className="inspector w-full min-w-0 flex-1 min-h-0 flex flex-col bg-subtle overflow-hidden" aria-label={t("finderComponents.inspectorAside")} data-automation-assistant>
			{chatView !== undefined && chatView !== null ? (
				chatView
			) : (
				<>
					{chatHead === undefined || chatHead === null ? null : chatHead}
					<FadedDazziMark caption={t("automations.assistant.caption")} />
					{chatDock === undefined || chatDock === null ? null : <div className="inspector-dock-slot flex-none bg-subtle">{chatDock}</div>}
				</>
			)}
		</aside>
	);
}
