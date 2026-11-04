/**
 * Self-contained AccessGate HTML served to unauthenticated browsers at `GET /`,
 * adapted from Ovis (`devswha/ovis`, MIT `AccessGate.tsx`).
 *
 * - One-shot exchange of `?pair=CODE` from a scanned QR code or link; `pair` is taken off
 *   `location` with `history.replaceState` so a spent code never stays in history.
 * - 6-digit pairing code input (`inputmode="numeric"`, `autocomplete="one-time-code"`).
 * - Collapsible access-token fallback (`POST /remote/auth`).
 * - Cookie confirmation through `GET /remote/health` before reloading into Finder.
 * - Copy comes from the shared locale files (`main.remoteGate.*`) in the host's interface language.
 */
import { APP_FULL_NAME, APP_NAME } from "../../shared/app-info";
import { i18n } from "../../shared/i18n/core";
import { REMOTE_CSRF_HEADER, REMOTE_ROUTES, type RemoteAccessRefusal } from "../../shared/remote-contract";
import type { AppSettings } from "../../shared/settings-contract";

function gateStrings(language: AppSettings["language"]) {
	const t = i18n.getFixedT(language);
	return {
		codeLabel: t("main.remoteGate.codeLabel"),
		codeShortError: t("main.remoteGate.codeShortError"),
		codeInvalidError: t("main.remoteGate.codeInvalidError"),
		codeSubmit: t("main.remoteGate.codeSubmit"),
		codeSubmitting: t("main.remoteGate.codeSubmitting"),
		tokenToggle: t("main.remoteGate.tokenToggle"),
		tokenLabel: t("main.remoteGate.tokenLabel"),
		tokenSubmit: t("main.remoteGate.tokenSubmit"),
		tokenSubmitting: t("main.remoteGate.tokenSubmitting"),
		tokenInvalidError: t("main.remoteGate.tokenInvalidError"),
		rateLimitedError: t("main.remoteGate.rateLimitedError"),
		cookieBlockedError: t("main.remoteGate.cookieBlockedError"),
	};
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function renderAccessGateHtml(options: {
	readonly language: AppSettings["language"];
	readonly appearance: AppSettings["appearance"];
	readonly reason: RemoteAccessRefusal;
	/** The Dazzi mark as a `data:image/png;base64,...` URL (the page's CSP allows only `data:` images). */
	readonly logoDataUrl: string | null;
}): string {
	const copy = gateStrings(options.language);
	const dark = options.appearance === "dark";
	const clientPayload = JSON.stringify({
		routes: {
			pair: REMOTE_ROUTES.pair,
			auth: REMOTE_ROUTES.auth,
			health: REMOTE_ROUTES.health,
		},
		csrfHeader: REMOTE_CSRF_HEADER,
		copy,
	}).replaceAll("<", "\\u003c");

	return `<!doctype html>
<html lang="${escapeHtml(options.language)}" data-appearance="${escapeHtml(options.appearance)}">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;" />
	<title>${escapeHtml(APP_FULL_NAME)}</title>
	<style>
		:root {
			color-scheme: ${dark ? "dark" : "light"};
			--bg: ${dark ? "#161618" : "#F5F5F7"};
			--card: ${dark ? "#1F1F23" : "#FFFFFF"};
			--border: ${dark ? "#323238" : "#D9DADD"};
			--ink: ${dark ? "#F4F4F6" : "#1D1D1F"};
			--muted: ${dark ? "#A0A0AB" : "#6E6E73"};
			--input-bg: ${dark ? "#28282D" : "#F0F0F4"};
			--accent: #0A64D8;
			--accent-hover: #0854B8;
			--danger-bg: ${dark ? "rgba(255,69,58,0.14)" : "rgba(217,48,37,0.08)"};
			--danger-ink: ${dark ? "#FF6961" : "#C5221F"};
			--warn-bg: ${dark ? "rgba(255,159,10,0.15)" : "rgba(194,94,0,0.09)"};
			--warn-ink: ${dark ? "#FFB340" : "#9A4A00"};
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			min-height: 100dvh;
			display: grid;
			place-items: center;
			padding: 24px 16px;
			background: var(--bg);
			color: var(--ink);
			font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Pretendard Variable", "Segoe UI", sans-serif;
			-webkit-font-smoothing: antialiased;
		}
		.gate-card {
			width: 100%;
			max-width: 400px;
			background: var(--card);
			border: 1px solid var(--border);
			border-radius: 16px;
			padding: 28px 24px 24px;
			box-shadow: 0 12px 32px rgba(0, 0, 0, ${dark ? "0.38" : "0.08"});
		}
		.gate-head {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 10px;
			margin-bottom: 22px;
		}
		.gate-logo {
			display: block;
			width: 64px;
			height: 64px;
		}
		h1 {
			margin: 0;
			font-size: 22px;
			font-weight: 650;
			letter-spacing: -0.01em;
			text-align: center;
		}
		.gate-notice {
			margin: 0 0 16px;
			padding: 10px 12px;
			border-radius: 9px;
			background: var(--warn-bg);
			color: var(--warn-ink);
			font-size: 12.5px;
			line-height: 1.45;
		}
		label {
			display: block;
			font-size: 12.5px;
			font-weight: 500;
			margin-bottom: 6px;
		}
		.gate-input {
			width: 100%;
			height: 44px;
			padding: 0 14px;
			border: 1px solid var(--border);
			border-radius: 10px;
			background: var(--input-bg);
			color: var(--ink);
			font-size: 16px;
			outline: none;
		}
		.gate-input--code {
			font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
			font-size: 22px;
			font-weight: 600;
			letter-spacing: 0.18em;
			text-align: center;
		}
		.gate-input:focus {
			border-color: var(--accent);
			background: var(--card);
		}
		.gate-btn {
			margin-top: 12px;
			width: 100%;
			height: 40px;
			border: 0;
			border-radius: 10px;
			background: var(--accent);
			color: #fff;
			font-size: 14px;
			font-weight: 500;
			cursor: pointer;
		}
		.gate-btn:hover:not(:disabled) { background: var(--accent-hover); }
		.gate-btn:disabled { opacity: 0.55; cursor: default; }
		.gate-error {
			margin: 12px 0 0;
			padding: 10px 12px;
			border-radius: 9px;
			background: var(--danger-bg);
			color: var(--danger-ink);
			font-size: 12.5px;
			line-height: 1.45;
		}
		details.gate-alt {
			margin-top: 18px;
			padding-top: 14px;
			border-top: 1px solid var(--border);
		}
		details.gate-alt summary {
			font-size: 12.5px;
			color: var(--muted);
			cursor: pointer;
			user-select: none;
		}
		details.gate-alt form {
			margin-top: 12px;
		}
	</style>
</head>
<body>
	<main class="gate-card" data-testid="remote-access-gate">
		<div class="gate-head">
			${options.logoDataUrl === null ? "" : `<img class="gate-logo" src="${options.logoDataUrl}" alt="" aria-hidden="true" />`}
			<h1 id="gate-title">${escapeHtml(APP_NAME)}</h1>
		</div>
		<form id="pair-form" aria-labelledby="gate-title" novalidate>
			<label for="pair-code">${escapeHtml(copy.codeLabel)}</label>
			<input
				id="pair-code"
				class="gate-input gate-input--code"
				type="text"
				inputmode="numeric"
				autocomplete="one-time-code"
				pattern="[0-9 ]*"
				maxlength="7"
				placeholder="000 000"
				autofocus
			/>
			<button id="pair-submit" type="submit" class="gate-btn">${escapeHtml(copy.codeSubmit)}</button>
		</form>
		<details class="gate-alt">
			<summary>${escapeHtml(copy.tokenToggle)}</summary>
			<form id="token-form" novalidate>
				<label for="access-token">${escapeHtml(copy.tokenLabel)}</label>
				<input
					id="access-token"
					class="gate-input"
					type="password"
					autocomplete="current-password"
				/>
				<button id="token-submit" type="submit" class="gate-btn">${escapeHtml(copy.tokenSubmit)}</button>
			</form>
		</details>
		<p id="gate-error" class="gate-error" role="alert" hidden></p>
	</main>
	<script>
	(() => {
		const cfg = ${clientPayload};
		const codeInput = document.getElementById("pair-code");
		const pairSubmit = document.getElementById("pair-submit");
		const pairForm = document.getElementById("pair-form");
		const tokenInput = document.getElementById("access-token");
		const tokenSubmit = document.getElementById("token-submit");
		const tokenForm = document.getElementById("token-form");
		const errorBox = document.getElementById("gate-error");
		let busy = false;

		const deviceLabel = () => {
			const ua = navigator.userAgent || "";
			const tp = navigator.maxTouchPoints || 0;
			const dev = /iPhone/.test(ua) ? "iPhone"
				: (/iPad/.test(ua) || (/Macintosh/.test(ua) && tp > 1)) ? "iPad"
				: /Android/.test(ua) ? "Android"
				: /Macintosh/.test(ua) ? "Mac"
				: /Windows/.test(ua) ? "Windows"
				: /CrOS/.test(ua) ? "Chromebook"
				: /Linux/.test(ua) ? "Linux" : "Device";
			const br = /Edg\\//.test(ua) ? "Edge"
				: /Firefox\\//.test(ua) ? "Firefox"
				: (/Chrome\\/|Chromium\\//.test(ua)) ? "Chrome"
				: /Safari\\//.test(ua) ? "Safari" : "";
			return br ? dev + " · " + br : dev;
		};

		const formatDigits = (raw) => {
			const digits = String(raw || "").replace(/\\D/g, "").slice(0, 6);
			return digits.length > 3 ? digits.slice(0, 3) + " " + digits.slice(3) : digits;
		};

		const showError = (msg) => {
			errorBox.textContent = msg;
			errorBox.hidden = !msg;
		};

		const setBusy = (mode) => {
			busy = mode !== null;
			pairSubmit.disabled = busy;
			tokenSubmit.disabled = busy;
			pairSubmit.textContent = mode === "code" ? cfg.copy.codeSubmitting : cfg.copy.codeSubmit;
			tokenSubmit.textContent = mode === "token" ? cfg.copy.tokenSubmitting : cfg.copy.tokenSubmit;
		};

		const confirmAndReload = async () => {
			const check = await fetch(cfg.routes.health, { credentials: "same-origin", cache: "no-store" });
			const data = await check.json().catch(() => null);
			if (data && data.authenticated === true) {
				location.replace(location.pathname + location.search + location.hash);
				return true;
			}
			showError(cfg.copy.cookieBlockedError);
			setBusy(null);
			return false;
		};

		const submitCode = async (digits) => {
			if (busy) return;
			setBusy("code");
			showError("");
			try {
				const res = await fetch(cfg.routes.pair, {
					method: "POST",
					credentials: "same-origin",
					headers: {
						"content-type": "application/json",
						[cfg.csrfHeader]: "1",
					},
					body: JSON.stringify({ code: digits, label: deviceLabel() }),
				});
				if (res.status === 429) {
					showError(cfg.copy.rateLimitedError);
					setBusy(null);
					return;
				}
				if (!res.ok) {
					showError(cfg.copy.codeInvalidError);
					setBusy(null);
					codeInput.select();
					return;
				}
				await confirmAndReload();
			} catch (err) {
				showError(err instanceof Error ? err.message : String(err));
				setBusy(null);
			}
		};

		codeInput.addEventListener("input", () => {
			codeInput.value = formatDigits(codeInput.value);
		});

		pairForm.addEventListener("submit", (event) => {
			event.preventDefault();
			const digits = codeInput.value.replace(/\\D/g, "");
			if (digits.length !== 6) {
				showError(cfg.copy.codeShortError);
				codeInput.focus();
				return;
			}
			void submitCode(digits);
		});

		tokenForm.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (busy) return;
			const token = tokenInput.value.trim();
			if (!token) {
				tokenInput.focus();
				return;
			}
			setBusy("token");
			showError("");
			try {
				const res = await fetch(cfg.routes.auth, {
					method: "POST",
					credentials: "same-origin",
					headers: {
						"content-type": "application/json",
						[cfg.csrfHeader]: "1",
					},
					body: JSON.stringify({ token }),
				});
				if (res.status === 429) {
					showError(cfg.copy.rateLimitedError);
					setBusy(null);
					return;
				}
				if (!res.ok) {
					showError(cfg.copy.tokenInvalidError);
					setBusy(null);
					tokenInput.select();
					return;
				}
				await confirmAndReload();
			} catch (err) {
				showError(err instanceof Error ? err.message : String(err));
				setBusy(null);
			}
		});

		// Take ?pair=CODE off the address bar immediately so it never stays in history.
		const currentUrl = new URL(location.href);
		const pairParam = currentUrl.searchParams.get("pair");
		if (pairParam !== null) {
			currentUrl.searchParams.delete("pair");
			history.replaceState(history.state, "", currentUrl.pathname + currentUrl.search + currentUrl.hash);
			const digits = pairParam.replace(/\\D/g, "").slice(0, 6);
			if (digits.length === 6) {
				codeInput.value = formatDigits(digits);
				void submitCode(digits);
			}
		}
	})();
	</script>
</body>
</html>`;
}
