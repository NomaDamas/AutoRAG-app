/**
 * Icon for an AI provider: its brand logo (nominative use: the mark names the service the row connects to),
 * or the first-letter `AppIcon` when the provider has none. The tile is the same `settings-app-icon` box in
 * both cases, so a row does not change size when a provider gains or loses a logo. The logos are
 * monochrome and drawn in `currentColor`, so they follow the theme; the Dazzi plan keeps its own colored
 * mark. See `providerLogos.ts` for the mapping and THIRD_PARTY_NOTICES.md for the logo sources.
 */

import type { ReactElement } from "react";
import { AUTORAG_PROVIDER_ID } from "../../../../shared/account-contract";
import type { ProviderSummary } from "../../../../shared/settings-contract";
import dazziLogo from "../../assets/dazzi-logo.png";
import { providerLogoFor } from "./providerLogos";
import { AppIcon } from "./SettingsKit";

export type ProviderIdentity = Pick<ProviderSummary, "id" | "kind" | "name">;

/** The plan's row in the connect menu has a label but no `ProviderSummary` (it is filtered out of the lists). */
export const DAZZI_PLAN_PROVIDER: ProviderIdentity = { id: AUTORAG_PROVIDER_ID, kind: "runtime", name: "Dazzi" };

/** The logo to draw inside a tile `size` px wide, or `null` when the provider has none. Hidden from assistive tech: the name is always beside it. */
export function providerMark(provider: ProviderIdentity, size: number): ReactElement | null {
	if (provider.kind === "runtime" && provider.id === AUTORAG_PROVIDER_ID) {
		return <img className="settings-app-icon-logo" src={dazziLogo} width={size} height={size} alt="" draggable={false} />;
	}
	const paths = providerLogoFor(provider);
	if (paths === null) return null;
	return (
		<svg className="settings-app-icon-logo" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" aria-hidden="true" focusable="false">
			{paths.map((path) => (
				<path key={path.d} d={path.d} {...(path.fillOpacity === undefined ? {} : { fillOpacity: path.fillOpacity })} />
			))}
		</svg>
	);
}

export function ProviderIcon({ provider, small = false }: { readonly provider: ProviderIdentity; readonly small?: boolean }): ReactElement {
	const mark = providerMark(provider, small ? 12 : 18);
	if (mark === null) return <AppIcon small={small} label={provider.name} />;
	return (
		<span className={`settings-app-icon${small ? " is-sm" : ""}`} aria-hidden="true">
			{mark}
		</span>
	);
}
