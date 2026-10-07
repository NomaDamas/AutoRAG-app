/** Step 2 — macOS Full Disk Access / Windows notifications + firewall. */

import type { ReactElement, ReactNode } from "react";
import { Icon } from "../marks";
import { Eyebrow, Multiline, PermissionRow, SplitScreen, Switch } from "../parts";
import type { OnboardingCtx } from "../context";

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
		<>
			<div className="permission-list">
				<PermissionRow
					icon="hard-drive"
					tone="blue"
					name={t("onboarding.permissions.fda.name")}
					tag={t("onboarding.permissions.required")}
					tagTone="req"
					desc={t("onboarding.permissions.fda.desc")}
					action={fdaAction}
				/>
				<PermissionRow
					icon="bell"
					tone="orange"
					name={t("onboarding.permissions.notifications.name")}
					tag={t("onboarding.permissions.optional")}
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
				<PermissionRow
					icon="power"
					name={t("onboarding.permissions.login.name")}
					tag={t("onboarding.permissions.setting")}
					desc={t("onboarding.permissions.login.desc")}
					action={
						<Switch
							on={draft.launchAtLogin}
							label={t("onboarding.permissions.login.name")}
							onClick={() => ctx.setLaunchAtLogin(!draft.launchAtLogin)}
						/>
					}
				/>
			</div>
			{granted ? null : (
				<div className="permission-footnote">
					<Icon name="triangle-alert" size={14} />
					<span>{t("onboarding.permissions.footnote")}</span>
				</div>
			)}
			<button type="button" className="guide-link" onClick={() => ctx.openOverlay("why")}>
				{t("onboarding.permissions.whyLink")}
			</button>
		</>
	);
}

function WindowsPermissions({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft } = ctx;
	return (
		<div className="permission-list">
			<PermissionRow
				icon="bell"
				tone="orange"
				name={t("onboarding.permissions.notifications.name")}
				tag={t("onboarding.permissions.optional")}
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
			<PermissionRow
				icon="shield"
				tone="blue"
				name={t("onboarding.permissions.network.name")}
				tag={t("onboarding.permissions.optional")}
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
				icon="power"
				name={t("onboarding.permissions.login.name")}
				tag={t("onboarding.permissions.setting")}
				desc={t("onboarding.permissions.login.desc")}
				action={
					<Switch
						on={draft.launchAtLogin}
						label={t("onboarding.permissions.login.name")}
						onClick={() => ctx.setLaunchAtLogin(!draft.launchAtLogin)}
					/>
				}
			/>
		</div>
	);
}

export function PermissionsStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, platform } = ctx;
	return (
		<SplitScreen
			copy={
				<>
					<Eyebrow icon="shield-check">{t("onboarding.permissions.eyebrow")}</Eyebrow>
					<h1>
						<Multiline text={t("onboarding.permissions.title")} />
					</h1>
					<p>{platform === "win32" ? t("onboarding.permissions.leadWindows") : t("onboarding.permissions.leadMac")}</p>
					<div className="micro-note">
						<Icon name="lock" size={14} />
						<span>{t("onboarding.permissions.note")}</span>
					</div>
				</>
			}
		>
			{platform === "win32" ? <WindowsPermissions ctx={ctx} /> : <MacPermissions ctx={ctx} />}
		</SplitScreen>
	);
}
