/**
 * Self-contained AccessGate HTML served to unauthenticated browsers at `GET /`,
 * adapted from Ovis (`devswha/ovis`, MIT `AccessGate.tsx`).
 *
 * Features:
 * - Automatic one-shot exchange of `?pair=CODE` from a scanned QR code or link,
 *   immediately stripping `pair` from `location` via `history.replaceState` so
 *   spent codes never linger in browser history or referrers.
 * - 6-digit numeric pairing code input (`inputmode="numeric"`, `autocomplete="one-time-code"`).
 * - Collapsible access-token fallback (`POST /remote/auth`).
 * - Cookie confirmation check via `GET /remote/health` before reloading into Finder.
 * - Localized into `ko`, `en`, `ja`, and `zh` with light/dark theme tokens.
 */
import { APP_FULL_NAME, APP_NAME } from "../../shared/app-info";
import { REMOTE_CSRF_HEADER, REMOTE_ROUTES, type RemoteAccessRefusal } from "../../shared/remote-contract";
import type { AppSettings } from "../../shared/settings-contract";

export interface GateStrings {
	readonly subtitle: string;
	readonly otherUserNotice: string;
	readonly codeLabel: string;
	readonly codePlaceholder: string;
	readonly codeShortError: string;
	readonly codeInvalidError: string;
	readonly codeSubmit: string;
	readonly codeSubmitting: string;
	readonly tokenToggle: string;
	readonly tokenLabel: string;
	readonly tokenSubmit: string;
	readonly tokenSubmitting: string;
	readonly tokenInvalidError: string;
	readonly rateLimitedError: string;
	readonly cookieBlockedError: string;
}

const DEFAULT_STRINGS: Record<AppSettings["language"], GateStrings> = {
	ko: {
		subtitle: "호스트 PC의 Dazzi 설정 → 일반 → 원격 접속에서 발급한 6자리 페어링 코드를 입력하거나 QR 코드를 스캔하세요.",
		otherUserNotice: "Tailscale 계정이 호스트 소유자와 다릅니다. 호스트에서 발급한 페어링 코드로 이 기기를 승인할 수 있습니다.",
		codeLabel: "페어링 코드 (6자리)",
		codePlaceholder: "000 000",
		codeShortError: "6자리 숫자를 모두 입력해 주세요.",
		codeInvalidError: "코드가 올바르지 않거나 만료되었습니다. 호스트 PC에서 새 코드를 발급하세요.",
		codeSubmit: "이 기기 페어링",
		codeSubmitting: "연결 중…",
		tokenToggle: "액세스 토큰으로 직접 열기",
		tokenLabel: "액세스 토큰",
		tokenSubmit: "잠금 해제",
		tokenSubmitting: "확인 중…",
		tokenInvalidError: "액세스 토큰이 일치하지 않습니다.",
		rateLimitedError: "시도 횟수가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
		cookieBlockedError: "브라우저 쿠키를 확인할 수 없습니다. 쿠키 허용 설정을 확인한 뒤 다시 시도해 주세요.",
	},
	en: {
		subtitle: "Enter the 6-digit pairing code from Settings → General → Remote Access on the host computer, or scan its QR code.",
		otherUserNotice: "Tailscale reports a different account than this computer's owner. You can still pair this device with a pairing code.",
		codeLabel: "Pairing code (6 digits)",
		codePlaceholder: "000 000",
		codeShortError: "Enter all 6 digits of the pairing code.",
		codeInvalidError: "That code is wrong, used up, or expired. Generate a new code on the host computer.",
		codeSubmit: "Pair this device",
		codeSubmitting: "Pairing…",
		tokenToggle: "Have an access token instead?",
		tokenLabel: "Access token",
		tokenSubmit: "Unlock",
		tokenSubmitting: "Unlocking…",
		tokenInvalidError: "Access token does not match.",
		rateLimitedError: "Too many attempts. Please wait a moment and try again.",
		cookieBlockedError: "Could not confirm the session cookie. Check that cookies are enabled in this browser.",
	},
	ja: {
		subtitle: "ホスト PC の「設定 → 一般 → リモートアクセス」で発行した 6 桁のペアリングコードを入力するか、QR コードを読み取ってください。",
		otherUserNotice: "Tailscale のアカウントがこの PC の所有者と異なります。ペアリングコードを使ってこの端末を承認できます。",
		codeLabel: "ペアリングコード（6桁）",
		codePlaceholder: "000 000",
		codeShortError: "6桁の数字をすべて入力してください。",
		codeInvalidError: "コードが正しくないか、使用済みまたは期限切れです。ホスト PC で新しいコードを発行してください。",
		codeSubmit: "この端末をペアリング",
		codeSubmitting: "ペアリング中…",
		tokenToggle: "アクセストークンをお持ちですか？",
		tokenLabel: "アクセストークン",
		tokenSubmit: "ロック解除",
		tokenSubmitting: "確認中…",
		tokenInvalidError: "アクセストークンが一致しません。",
		rateLimitedError: "試行回数が多すぎます。しばらく待ってから再試行してください。",
		cookieBlockedError: "セッション Cookie を確認できませんでした。ブラウザーの Cookie 設定を確認してください。",
	},
	zh: {
		subtitle: "输入主机 Dazzi“设置 → 通用 → 远程访问”中生成的 6 位配对码，或扫描二维码连接。",
		otherUserNotice: "Tailscale 账号与该电脑所有者不一致。您仍可使用主机生成的配对码授权此设备。",
		codeLabel: "配对码（6 位数字）",
		codePlaceholder: "000 000",
		codeShortError: "请输入完整的 6 位数字配对码。",
		codeInvalidError: "配对码错误、已失效或已过期。请在主机上生成新代码。",
		codeSubmit: "配对此设备",
		codeSubmitting: "正在配对…",
		tokenToggle: "使用访问令牌解锁？",
		tokenLabel: "访问令牌",
		tokenSubmit: "解锁",
		tokenSubmitting: "正在验证…",
		tokenInvalidError: "访问令牌不匹配。",
		rateLimitedError: "尝试次数过多，请稍后再试。",
		cookieBlockedError: "无法确认浏览器 Cookie，请检查浏览器是否允许 Cookie 后重试。",
	},
};

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
	readonly strings?: GateStrings;
}): string {
	const copy = options.strings ?? DEFAULT_STRINGS[options.language] ?? DEFAULT_STRINGS.ko;
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
		.gate-badge {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 42px;
			height: 42px;
			border-radius: 11px;
			background: var(--accent);
			color: #fff;
			font-weight: 700;
			font-size: 20px;
			margin-bottom: 14px;
		}
		h1 {
			margin: 0 0 8px;
			font-size: 20px;
			font-weight: 600;
			letter-spacing: -0.01em;
		}
		.gate-subtitle {
			margin: 0 0 20px;
			font-size: 13.5px;
			line-height: 1.5;
			color: var(--muted);
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
		<div class="gate-badge" aria-hidden="true">D</div>
		<h1 id="gate-title">${escapeHtml(APP_NAME)}</h1>
		${options.reason === "other_user" ? `<p class="gate-notice" role="status">${escapeHtml(copy.otherUserNotice)}</p>` : ""}
		<p class="gate-subtitle">${escapeHtml(copy.subtitle)}</p>
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
				placeholder="${escapeHtml(copy.codePlaceholder)}"
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
