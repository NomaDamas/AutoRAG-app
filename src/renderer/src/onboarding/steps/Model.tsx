/** Step 8 (BYOK only) — connect a model provider and verify the key. */

import type { ReactElement } from "react";
import type { ByokProviderId } from "../../../../shared/onboarding-contract";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { Eyebrow, Multiline, SplitScreen } from "../parts";
import type { OnboardingCtx } from "../context";

const PROVIDERS: readonly ByokProviderId[] = [
	"anthropic",
	"openai",
	"openrouter",
	"google",
	"ollama",
	"openai-compatible",
];

export function ModelStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, models, modelKey, modelOptions, verifying, modelError } = ctx;
	const model = draft.model;
	const provider = model?.provider ?? "anthropic";
	const verified = model?.verified === true;

	return (
		<SplitScreen
			copy={
				<>
					<Eyebrow icon="brain">{t("onboarding.model.eyebrow")}</Eyebrow>
					<h1>{t("onboarding.model.title")}</h1>
					<p>{t("onboarding.model.lead")}</p>
					<div className="micro-note">
						<Icon name="lock" size={14} />
						<span>{t("onboarding.model.note")}</span>
					</div>
				</>
			}
		>
			<div>
				{models.length > 0 ? (
					<div className="detected">
						<div className="detected-title">{t("onboarding.model.detectedTitle")}</div>
						{models.map((detected) => (
							<div key={detected.provider} className="detected-row">
								<span className="source-icon">
									<Icon name={detected.origin === "local" ? "cpu" : "key-round"} size={14} />
								</span>
								<div>
									<strong>{t(`onboarding.model.provider.${detected.provider}`)}</strong>
									<small>
										{detected.origin === "local"
											? t("onboarding.model.localRuntime")
											: (detected.envName ?? t("onboarding.model.storedCredential"))}
									</small>
								</div>
								<button
									type="button"
									className="secondary"
									onClick={() => {
										ctx.setModelProvider(detected.provider);
										ctx.verifyModel(detected.provider);
									}}
								>
									{t("onboarding.model.use")}
								</button>
							</div>
						))}
					</div>
				) : null}
				<div className="card" style={{ padding: 14 }}>
					<div className="provider-chips">
						{PROVIDERS.map((id) => (
							<button
								key={id}
								type="button"
								className={cn("provider-chip", provider === id && "selected")}
								onClick={() => ctx.setModelProvider(id)}
							>
								{t(`onboarding.model.provider.${id}`)}
							</button>
						))}
					</div>
					{provider === "openai-compatible" ? (
						<div className="key-row">
							<input
								className="input"
								type="text"
								placeholder={t("onboarding.model.baseUrlPlaceholder")}
								value={model?.baseUrl ?? ""}
								onChange={(e) => ctx.setModelBaseUrl(e.target.value)}
							/>
						</div>
					) : null}
					<div className="key-row">
						<input
							className="input"
							type="password"
							placeholder={t("onboarding.model.keyPlaceholder")}
							value={modelKey}
							onChange={(e) => ctx.setModelKey(e.target.value)}
						/>
						<button type="button" className="secondary" disabled={verifying} onClick={() => ctx.verifyModel()}>
							{verifying ? t("onboarding.model.verifying") : t("onboarding.model.verify")}
						</button>
					</div>
					<p style={{ fontSize: 10, color: "var(--onb-muted)" }}>
						{modelError !== null
							? t("onboarding.model.error", { error: modelError })
							: verified
								? t("onboarding.model.verified")
								: t("onboarding.model.unverified")}
					</p>
					<details>
						<summary style={{ fontSize: 11, color: "var(--onb-muted)", cursor: "pointer" }}>
							{t("onboarding.model.advanced")}
						</summary>
						<div className="model-row">
							<span>{t("onboarding.model.modelRow")}</span>
							{modelOptions.length > 0 ? (
								<select
									value={model?.modelId ?? ""}
									onChange={(e) => ctx.patch({ model: { ...(model ?? { provider, baseUrl: "", verified: false }), modelId: e.target.value } })}
								>
									<option value="">{t("onboarding.model.recommended")}</option>
									{modelOptions.map((option) => (
										<option key={option.id} value={option.id}>
											{option.name}
										</option>
									))}
								</select>
							) : (
								<b>{t("onboarding.model.recommended")}</b>
							)}
						</div>
						<div className="model-row">
							<span>{t("onboarding.model.reasoningRow")}</span>
							<b>{t("onboarding.model.reasoningValue")}</b>
						</div>
					</details>
				</div>
			</div>
		</SplitScreen>
	);
}
