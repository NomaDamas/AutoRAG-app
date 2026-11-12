# Data flows

What Dazzi does with personal data, derived from the code at `a0b3e20` (2026-10-18).
It is the engineering input for the Privacy Policy (served from the `Dazzi`
repository, `src/app/(legal)/privacy`) and for GDPR Art. 30 records. Update it
in the same change that adds or alters a flow.

Operator: NomaDamas (South Korea). Privacy contact: privacy@dazziapp.com.

## Flows that leave the device

| Flow | Trigger | What leaves | Goes to | Evidence |
|---|---|---|---|---|
| Account sign-in | User signs in (system browser). The sign-in also carries the device's anonymous guest `device_id`, so the trial's usage moves onto the account and the guest key is invalidated | Email and provider profile, handled on the web, not in the app; the device hash | `api.dazziapp.com` (Vercel, Neon, Resend; GitHub/Google/Apple if chosen) | `src/shared/account-contract.ts`, `src/main/account-service.ts` |
| Anonymous guest trial | A signed-out app provisions guest access (`POST /api/desktop/guest`) or asks a question/the first run reaches setup | The `device_id` (SHA-256 of a device seed under the `dazzi-device-v1:` namespace — never a raw hardware id), plus the same question/excerpts an AI run sends | `api.dazziapp.com` (Vercel, Neon); the run's content then follows the AI-answer flow below | `src/main/device-id.ts`, `src/main/account-service.ts` (`ensureGuestAccess`, `guestQuotaStatus`) |
| Cloud embedding | User (in Settings) signs in, picks cloud embedding **and** ticks the consent box; Pro plan only | Text of documents in the selected folders | Dazzi API, then DeepInfra | `src/main/embedding-settings-service.ts`, `src/renderer/src/settings` (cloud consent), `en.json` `embedding.*` |
| AI answers, managed model | User asks a question with a Dazzi-managed model | Question and the excerpts the agent retrieves | Dazzi API, then OpenRouter and the company that runs the selected model; Dazzi no longer restricts routing to zero-data-retention endpoints | `src/main/account-service.ts` (`useManagedModel`, `/v1/models`) |
| AI answers, BYOK | User connected their own provider key | Same content | The provider the user configured, directly; not Dazzi | `docs/architecture.md` (AI Search, first-run tour question), `README.md` |
| First-run tour question | A model is configured when the first run starts indexing; the first index is still being built or has just finished | ~2,000-character excerpts of the user's own parsed documents, eight at a time and at most 40 per run, plus the prompt asking for a question per document (to the answer model). Each question that keyword retrieval proves comes from its own document is then sent with its document's excerpt to Jev, to score it | The answer model: the configured provider only (the user's own BYOK provider, or the Dazzi API for a managed model). Jev: the Dazzi API (`/v1/jev`) and only with a Dazzi credential; with none, nothing is scored and no question is shown. Never sent when no model is configured | `src/main/first-run-service.ts` (`startHunt`/`finishHunt`, `resolveConfiguredSessionModel` + `completeSimple`), `src/main/demo-question-hunt.ts`, `src/main/demo-question-judge.ts` |
| Error reports | **Off by default**; Settings → General → Privacy "Send Error Reports" turns it on. The first run never asks | Scrubbed error text, stack, app version, OS/device context, counts and step names | Sentry, US region (`ingest.us.sentry.io`) | `src/main/error-reporting.ts`, `src/main/error-report-core.ts`, `docs/architecture.md` |
| Usage statistics | **Off by default**; the Settings switch turns it on. The first run never asks | Fixed-schema anonymous events plus a random install ID | PostHog, US region in the release workflow variable `POSTHOG_HOST` | `src/shared/analytics-contract.ts`, `docs/architecture.md` |
| Update check | Packaged build with an update feed | IP address and app version in the request | `dl.nomadamas.org` (Cloudflare R2) | `electron-builder.config.mjs`, `src/main/app-update-host.ts` |

## What stays on the device

- Local embedding (the default) and the search index. Corpus embedding and rerank
  endpoints are restricted to loopback or the Dazzi host
  (`assertNoRemoteEgress`, `src/main/autorag-config-service.ts`).
- Sign-in tokens and API keys, in the system credential store
  (`deps.credentials`). Signing out removes the local key; the key stays valid on
  the server until revoked in the web dashboard (`account-contract.ts`).
- Chat history and connected-source archives.

## Connected sources hold other people's data

The app can index KakaoTalk, Slack, Discord, Telegram, WhatsApp, mail, GitHub,
Notion, Lark, cloud drives, Obsidian and RSS (`en.json` `sources.*`, data-source
catalog). Chat and mail content includes personal data of third parties. That
content only leaves the device through the AI-answer and cloud-embedding flows
above. The Privacy Policy treats the user as responsible for that content and
Dazzi as acting on the user's behalf for it.

## Transfer mechanisms (checked 2026-10-18 against each provider's public terms)

| Provider | Basis found |
|---|---|
| Vercel | EU-US DPF (active); SCCs and UK addendum in its DPA |
| Neon | SCCs (Decision 2021/914) in its DPA |
| OpenRouter | DPA incorporating SCCs |
| DeepInfra | **None found**: its privacy policy only says data may be processed in the US; no public DPA, SCC or DPF statement |
| Resend | SCCs in its DPA (stated on its GDPR page) |
| Creem | EU entity (Armitage Labs OÜ, Estonia); SCCs for its non-EEA providers |
| Sentry (Functional Software) | EU-US DPF; SCCs in its DPA 5.1.0 |
| PostHog | EU-US DPF; SCCs in its DPA |
| Cloudflare | SCCs in its DPA and EU-US DPF |
| Google, GitHub | EU-US DPF |
| Apple | SCCs (stated in its privacy policy) |

Re-check when a provider is added or its terms change. DeepInfra receives the
text of cloud-embedding requests, so close that gap first (request a DPA with
SCCs from DeepInfra, or stop routing EEA traffic there).

## Not verifiable from this repository

- Retention periods at Sentry, PostHog, OpenRouter and the model providers.
- Sentry project settings (IP handling). PostHog "Discard client IP data" was
  confirmed on by the owner on 2026-10-18.
