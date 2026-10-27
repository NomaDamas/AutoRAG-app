/** Step 2 — macOS Full Disk Access, notifications and launch at login; Windows network, notifications and launch at login. */

import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Multiline, PermissionRow, Switch } from "../parts";
import type { OnboardingCtx } from "../context";

interface PermissionsScreenProps {
	readonly title: string;
	readonly lead: string;
	readonly children: ReactNode;
	readonly after?: ReactNode;
	readonly className?: string;
}

/** The step's shared layout: a centred heading over a list of plain rows (Figma 02 · permissions). */
function PermissionsScreen({ title, lead, children, after, className }: PermissionsScreenProps): ReactElement {
	return (
		<section className={cn("screen permissions-screen", className)}>
			<div className="permissions-head">
				<h1>{title}</h1>
				<p>
					<Multiline text={lead} />
				</p>
			</div>
			<div className="permission-list">{children}</div>
			{after}
		</section>
	);
}

function LaunchAtLoginRow({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft } = ctx;
	return (
		<PermissionRow
			icon="power"
			name={t("onboarding.permissions.login.name")}
			desc={t("onboarding.permissions.login.desc")}
			action={
				<Switch
					on={draft.launchAtLogin}
					label={t("onboarding.permissions.login.name")}
					onClick={() => ctx.setLaunchAtLogin(!draft.launchAtLogin)}
				/>
			}
		/>
	);
}

function MacPermissions({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, permissions, fdaPending } = ctx;
	const granted = permissions?.fullDiskAccess === true;

	let fdaAction: ReactNode;
	if (granted) {
		fdaAction = <span className="state ok">✓ {t("onboarding.permissions.granted")}</span>;
	} else if (fdaPending) {
		fdaAction = (
			<>
				<span className="state warn">{t("onboarding.permissions.restartNeeded")}</span>
				<button type="button" className="secondary" onClick={ctx.relaunch}>
					{t("onboarding.permissions.restartNow")}
				</button>
			</>
		);
	} else {
		fdaAction = (
			<button type="button" className="secondary" onClick={ctx.openFullDiskAccess}>
				{t("onboarding.permissions.openSettings")}
			</button>
		);
	}

	return (
		<PermissionsScreen
			title={t("onboarding.permissions.title")}
			lead={t("onboarding.permissions.leadMac")}
			after={
				<button type="button" className="inline-link permissions-why" onClick={() => ctx.openOverlay("fda")}>
					{t("onboarding.permissions.fda.why")}
				</button>
			}
		>
			<PermissionRow
				icon="hard-drive"
				tone="blue"
				name={t("onboarding.permissions.fda.name")}
				tag={t("onboarding.permissions.required")}
				tagTone="req"
				desc={<Multiline text={t("onboarding.permissions.fda.desc")} />}
				action={fdaAction}
			/>
			<PermissionRow
				icon="bell"
				tone="orange"
				name={t("onboarding.permissions.notifications.name")}
				desc={t("onboarding.permissions.notifications.desc")}
				action={
					draft.notifications ? (
						<span className="state ok">✓ {t("onboarding.permissions.granted")}</span>
					) : (
						<button type="button" className="secondary" onClick={ctx.requestNotifications}>
							{t("onboarding.permissions.notifications.allow")}
						</button>
					)
				}
			/>
			<LaunchAtLoginRow ctx={ctx} />
		</PermissionsScreen>
	);
}

function WindowsPermissions({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft } = ctx;
	return (
		<PermissionsScreen className="windows" title={t("onboarding.permissions.titleWindows")} lead={t("onboarding.permissions.leadWindows")}>
			<PermissionRow
				icon="shield"
				tone="blue"
				name={t("onboarding.permissions.network.name")}
				desc={t("onboarding.permissions.network.desc")}
				action={
					draft.network ? (
						<span className="state ok">✓ {t("onboarding.permissions.granted")}</span>
					) : (
						<button type="button" className="secondary" onClick={ctx.checkNetwork}>
							{t("onboarding.permissions.network.allow")}
						</button>
					)
				}
			/>
			<PermissionRow
				icon="bell"
				tone="orange"
				name={t("onboarding.permissions.notifications.name")}
				desc={t("onboarding.permissions.notifications.desc")}
				action={
					draft.notifications ? (
						<span className="state ok">✓ {t("onboarding.permissions.granted")}</span>
					) : (
						<button type="button" className="secondary" onClick={ctx.openNotificationSettings}>
							{t("onboarding.permissions.notifications.openWindows")}
						</button>
					)
				}
			/>
			<LaunchAtLoginRow ctx={ctx} />
		</PermissionsScreen>
	);
}

export function PermissionsStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	return ctx.platform === "win32" ? <WindowsPermissions ctx={ctx} /> : <MacPermissions ctx={ctx} />;
}
