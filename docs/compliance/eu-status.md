# EU regulatory status

Engineering view of GDPR, the EU AI Act and the Cyber Resilience Act (CRA) for
Dazzi, as of `a0b3e20` (2026-10-18). Not legal advice. Findings come from
reading the code and the published Privacy Policy and from running
`electron-audit`, `cra-scanner` and `bun audit`. Data flows are in
[`data-flows.md`](data-flows.md); vulnerability reporting is in
[`../../SECURITY.md`](../../SECURITY.md).

## GDPR

Roles: NomaDamas is controller for account, usage and security data and acts on
the user's behalf for the content of requests. The Privacy Policy, Terms and
Subprocessors pages live in the `Dazzi` repository (`src/app/(legal)`).

Covered by the Privacy Policy: desktop error reports, opt-in usage statistics,
update checks, off-device flows, Art. 6 legal bases, data-subject rights,
retention criteria, transfers, and the Sentry and Cloudflare subprocessors.

Open, and not fixable by documentation alone:

| Item | Why it is open |
|---|---|
| Error reports are on by default | Sending diagnostic data from the user's device without prior opt-in may need consent under ePrivacy Art. 5(3). Usage statistics are already opt-in; error reports are not. Decide whether to switch the default. |
| In-app wording | `onboarding.account.authNote` and `onboarding.embedding.cloudBulletNoStore` say Dazzi stores no request content; the Terms allow the Free plan to use Input and Output to improve the Service. The Privacy Policy now says the app wording does not limit that; the app strings still read broader. |
| Account deletion | Email only (`privacy@dazziapp.com`). The GDPR allows this; there is no in-app or dashboard delete. |
| Provider transfer mechanisms | Verified for every provider except DeepInfra (see `data-flows.md`). DeepInfra receives cloud-embedding text and has no public DPA, SCC or DPF statement; get a DPA with SCCs or stop sending EEA traffic there. |
| EU representative (Art. 27) and DPO | Not assessed; depends on whether Dazzi targets EU users. |
| Retention numbers | The policy gives criteria, not periods, for logs, Sentry and PostHog. |
| Website trackers | The policy lists Google Analytics and PostHog on the website and promises consent-gated loading. The landing page now has a consent banner and an analytics gate (`Dazzi-landing-page` `public/consent.js`), but no tracker is wired in yet; any tracker must use the gate. |

## EU AI Act

Classification: limited-risk. A retrieval assistant over the user's own files; no
Annex III use found in the code. The "Jev" model's role in decisions about
people was not assessed.

| Obligation | Status |
|---|---|
| Art. 50(1) tell users they interact with AI | The surface is titled "AI Search" and "Ask Dazzi"; there is no explicit "AI-generated" notice. The Terms state that Output is AI-generated. |
| Art. 50(2) mark synthetic content | Not assessed for the image-edit and video-convert actions (`inspector.actions.imageEdit`, `videoConvert`); relevant only if they generate content. |

## CRA

Dazzi is sold (Air, Pro plans), so it likely counts as a product with digital
elements. Manufacturer reporting duties (Art. 14) apply from 2026-09-11, the
rest from 2027-12-11.

Reporting clock for an actively exploited vulnerability or severe incident:
early warning within 24 hours, notification within 72 hours, final report within
14 days of a corrective measure, through the ENISA single reporting platform.
Check the current text of Art. 14 before relying on these numbers.

| Requirement | Status |
|---|---|
| Vulnerability disclosure policy and contact | `SECURITY.md` |
| Secure update mechanism | Signed installers, update feed, `allowDowngrade = false` |
| SBOM | Not generated for releases |
| Dependency update automation | None configured |
| Known vulnerabilities | `bun audit` (2026-10-18): 8, of which 7 high. `xlsx@0.18.5` (direct, prototype pollution and ReDoS, parses user files), `sharp` (via `kordoc` and `@huggingface/transformers`), `image-size`, `sprintf-js` |
| Renderer sandbox | `sandbox: false` in `src/main/index.ts` and `src/preview/node/window.ts`; reason not documented |
| Support period (Art. 13(8)) | Not declared; `SECURITY.md` says the latest release only |
| `style-src 'unsafe-inline'` in CSP | Present in two places |
| `shell.openExternal` | `fs-service.ts` validates with `webUrl()`; the worker host op in `fs-worker-host.ts` passes the URL through |

`electron-audit` also reported two critical command-injection patterns in
`scripts/manual-qa/*`; those are developer QA scripts and are not shipped.

## Deliberately left unchanged

Documentation only. These need code, build or configuration changes and remain
open: error-report default, in-app wording, AI notice in the UI, SBOM
generation, Dependabot, dependency upgrades, sandbox and CSP, an account
deletion path.
