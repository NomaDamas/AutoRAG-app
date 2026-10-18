# Security policy

## Reporting a vulnerability

Email **security@dazziapp.com**. Please do not open a public issue or pull
request for a vulnerability.

Include what you can of: the affected version (shown in the window title and the
installer's file name), your operating system, steps to reproduce, and the
impact you expect. A proof of concept helps but is not required.

What happens next:

- We acknowledge your report and tell you whom you are talking to.
- We confirm or reject the finding and keep you informed until it is fixed.
- We release the fix through the signed update feed (see below) and, once users
  can update, describe the issue in the release notes. We credit you if you want
  to be named.
- We ask you to keep the details private until a fix is available, and we will
  tell you when that is.

The same address takes reports about the hosted service at
`api.dazziapp.com` (account, billing and model API).

## Scope

In scope: the Dazzi desktop app (this repository), its installers and its update
feed, and the hosted service named above.

Out of scope: vulnerabilities in third-party software that Dazzi only embeds or
launches (report those upstream; tell us too if Dazzi's use of it makes them
exploitable), social engineering, and denial-of-service by volume.

## Supported versions

Only the latest release receives security fixes. The app updates itself from
`https://dl.nomadamas.org/latest/` when the release was built with the update
feed. Installers are signed when signing credentials are configured (macOS
Developer ID, Windows Azure signing; see `docs/release.md`). Older versions are
not patched.

## What we already do

- Renderer windows run with `contextIsolation` on and `nodeIntegration` off.
- Corpus embedding and rerank endpoints are restricted to loopback or the Dazzi
  host (`assertNoRemoteEgress` in `src/main/autorag-config-service.ts`).
- Error reports are scrubbed before they leave the device
  (`src/main/error-report-core.ts`).

Known open items and the regulatory status are tracked in
`docs/compliance/eu-status.md`.
