/**
 * Settings → 내 계정 / 구독 및 사용량.
 *
 * Both pages show what the hosted AutoRAG service confirmed for the signed-in
 * account (`window.autorag.account`). Nothing here is invented: while signed
 * out, or before the first answer, a value reads "확인할 수 없음". Sign-in,
 * checkout and the billing portal all happen in the system browser, so this app
 * never sees a password or a card number.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { ExternalLink } from "lucide-react";
import type { AccountPlanId, AccountSnapshot, AccountStatus, PaidPlanId } from "../../../../shared/account-contract";
import { accountLegalUrl, planCovers, type AccountLegalRoute } from "../../../../shared/account-contract";
import { Note, Row, Section, SettingsPageHead } from "./SettingsKit";

const UNKNOWN = "확인할 수 없음";

/** Opens one of the server's legal pages in the system browser (the routes the web login links). */
function openLegal(baseUrl: string | undefined, route: AccountLegalRoute): void {
	const open = window.autorag?.fs?.openUrl;
	if (typeof open === "function") void open(accountLegalUrl(baseUrl, route));
}

interface PlanTier {
	readonly id: AccountPlanId;
	readonly label: string;
	readonly price: string;
	readonly perks: string;
}

/** Product facts the service publishes (README "Plans"); credit figures are weekly dollar budgets. */
const PLAN_TIERS: readonly PlanTier[] = [
	{ id: "free", label: "Dazzi Free", price: "무료", perks: "주 $0.50 크레딧 · 분당 10회" },
	{ id: "air", label: "Dazzi Air", price: "월 $4", perks: "주 $1 크레딧 · 분당 60회" },
	{ id: "pro", label: "Dazzi Pro", price: "월 $20", perks: "주 $5 크레딧 · 분당 240회" },
];

const PLAN_LABEL: Readonly<Record<AccountPlanId, string>> = { free: "Free", air: "Air", pro: "Pro" };

function formatCents(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

/** The status the main process holds, kept fresh by its change events. */
function useAccount(): { readonly status: AccountStatus | null; readonly busy: boolean; readonly error: string | null; readonly run: (action: () => Promise<unknown>) => void } {
	const [status, setStatus] = useState<AccountStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const off = window.autorag.account.onChanged(setStatus);
		void window.autorag.account.status().then(setStatus);
		void window.autorag.account.refresh().then(setStatus, () => undefined);
		return off;
	}, []);

	const run = useCallback((action: () => Promise<unknown>): void => {
		setBusy(true);
		setError(null);
		action()
			.then(undefined, (cause: unknown) => {
				const text = cause instanceof Error ? cause.message : String(cause);
				setError(text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/u, ""));
			})
			.finally(() => setBusy(false));
	}, []);

	return { status, busy, error, run };
}

function accountOf(status: AccountStatus | null): AccountSnapshot | null {
	return status?.state === "signedIn" ? status.account : null;
}

export function AccountPage(): ReactElement {
	const { status, busy, error, run } = useAccount();
	const account = accountOf(status);
	const signedIn = status?.state === "signedIn";

	return (
		<>
			<SettingsPageHead title="내 계정" description="Dazzi 계정과 로그인 상태입니다." />
			<Section title="프로필">
				<Row name="Dazzi 계정" hint="로그인은 시스템 브라우저에서 진행되며, 이 앱은 비밀번호를 받지 않습니다.">
					<span className="settings-value">
						<span className={`settings-dot ${signedIn ? "is-ok" : "is-warn"}`} aria-hidden="true" />
					</span>
					<span className="settings-value">{status?.state === "signingIn" ? "브라우저에서 로그인 중…" : signedIn ? "로그인됨" : "로그인하지 않음"}</span>
				</Row>
				<Row name="이메일" hint="서버가 확인한 계정 이메일입니다.">
					<span className="settings-value">{account?.email ?? UNKNOWN}</span>
				</Row>
				{status?.offline === true ? <Note>서버에 연결할 수 없어 마지막으로 확인한 정보를 보여줍니다.</Note> : null}
				{status?.error ? <Note>{status.error}</Note> : null}
				{error !== null ? <Note>{error}</Note> : null}
				<Row
					name={signedIn ? "로그아웃" : "로그인"}
					hint={
						status?.source === "env"
							? "환경 변수 AUTORAG_API_KEY로 로그인되어 있어 앱에서 로그아웃할 수 없습니다."
							: signedIn
								? "이 Mac에 저장된 키를 삭제합니다. 키는 Dazzi 웹의 API 키 화면에서 폐기할 수 있습니다."
								: "브라우저가 열리고, 승인하면 이 앱으로 돌아옵니다."
					}
				>
					{signedIn ? (
						<button type="button" className="linear-btn" disabled={busy || status?.source === "env"} onClick={() => run(() => window.autorag.account.signOut())}>
							로그아웃
						</button>
					) : status?.state === "signingIn" ? (
						<button type="button" className="linear-btn" onClick={() => run(() => window.autorag.account.cancelSignIn())}>
							취소
						</button>
					) : (
						<button type="button" className="linear-btn" disabled={busy} onClick={() => run(() => window.autorag.account.signIn())}>
							브라우저에서 로그인
						</button>
					)}
				</Row>
			</Section>
			<Section title="AI 모델" description="Dazzi 계정의 관리형 모델을 AI 검색에 사용합니다.">
				<Row name="관리형 모델 사용" hint="AI 검색이 이 계정의 모델을 쓰도록 Dazzi 설정을 바꿉니다. 직접 입력한 API 키 설정은 이 단계에서 교체됩니다.">
					<button type="button" className="linear-btn" disabled={!signedIn || busy} onClick={() => run(() => window.autorag.account.useManagedModel())}>
						계정 모델로 설정
					</button>
				</Row>
			</Section>
			<Section title="약관 및 정책" description="웹 로그인 화면과 같은 문서입니다. 브라우저에서 열립니다.">
				<Row name="문서 보기" hint="서버 약관, 개인정보처리방침(모델별 데이터 처리), 수용 가능한 사용 정책, 하위 처리자 목록." stack>
					<div className="settings-legal-links">
						<button type="button" className="linear-btn settings-btn-quiet" onClick={() => openLegal(status?.baseUrl, "terms")}>
							서비스 약관
							<ExternalLink size={13} aria-hidden="true" focusable="false" />
						</button>
						<button type="button" className="linear-btn settings-btn-quiet" onClick={() => openLegal(status?.baseUrl, "privacy")}>
							개인정보처리방침
							<ExternalLink size={13} aria-hidden="true" focusable="false" />
						</button>
						<button type="button" className="linear-btn settings-btn-quiet" onClick={() => openLegal(status?.baseUrl, "acceptableUse")}>
							수용 가능한 사용 정책
							<ExternalLink size={13} aria-hidden="true" focusable="false" />
						</button>
						<button type="button" className="linear-btn settings-btn-quiet" onClick={() => openLegal(status?.baseUrl, "subprocessors")}>
							하위 처리자
							<ExternalLink size={13} aria-hidden="true" focusable="false" />
						</button>
					</div>
				</Row>
			</Section>
		</>
	);
}

export function PlanPage(): ReactElement {
	const { status, busy, error, run } = useAccount();
	const account = accountOf(status);
	const signedIn = status?.state === "signedIn";
	const plan = account?.plan ?? null;
	const usedCents = account?.creditsUsedCents ?? 0;
	const limitCents = account?.creditsLimitCents ?? 0;
	const percent = limitCents > 0 ? Math.min(100, Math.round((usedCents / limitCents) * 100)) : 0;
	const renewal = account?.periodEnd == null ? null : new Date(account.periodEnd).toLocaleDateString();

	return (
		<>
			<SettingsPageHead title="구독 및 사용량" description="Dazzi 요금제와 이번 주 AI 사용량을 확인합니다." />
			<Section title="현재 요금제">
				<Row name="현재 요금제" hint={signedIn ? "서버가 확인한 요금제입니다." : "요금제를 보려면 먼저 로그인하세요."}>
					<span className="settings-value is-strong">
						{plan === null ? UNKNOWN : `${PLAN_LABEL[plan]}${account?.trialing === true ? " · 체험 중" : ""}`}
					</span>
				</Row>
				{account?.cancelScheduled === true && renewal !== null ? <Note>해지가 예약되어 있습니다. {renewal}까지 현재 요금제를 사용할 수 있습니다.</Note> : null}
				{account !== null && account.status === "past_due" ? <Note>결제에 실패했습니다. 결제 포털에서 결제 수단을 확인하세요.</Note> : null}
				{error !== null ? <Note>{error}</Note> : null}
				{PLAN_TIERS.map((tier) => {
					const held = plan !== null && plan === tier.id;
					const paid = tier.id === "air" || tier.id === "pro";
					const available = tier.id === "air" ? account?.billing.air === true : tier.id === "pro" ? account?.billing.pro === true : false;
					return (
						<Row key={tier.id} name={tier.label} hint={`${tier.price} · ${tier.perks}`}>
							{held ? (
								<span className="settings-value">사용 중</span>
							) : paid && plan !== null && !planCovers(plan, tier.id) ? (
								<button type="button" className="linear-btn" disabled={busy || !available} onClick={() => run(() => window.autorag.account.checkout(tier.id as PaidPlanId))}>
									결제 페이지 열기
								</button>
							) : null}
						</Row>
					);
				})}
				<Row name="결제 관리" hint="결제 수단, 영수증, 구독 해지·환불은 결제 포털에서 관리합니다.">
					<button type="button" className="linear-btn" disabled={busy || account?.billing.portal !== true} onClick={() => run(() => window.autorag.account.portal())}>
						결제 포털 열기
					</button>
				</Row>
			</Section>
			<Section title="이번 주 사용량">
				<Row name="AI 사용량" hint="Dazzi 요금제 모델을 쓸 때 차감되는 주간 크레딧입니다." stack>
					<div className="settings-usage">
						<div className="settings-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="주간 크레딧 사용량">
							<span style={{ width: `${percent}%` }} />
						</div>
						<div className="settings-usage-legend">
							<span>{account === null ? "사용량을 불러올 수 없습니다" : `${formatCents(usedCents)} / ${formatCents(limitCents)}`}</span>
							<span>{account === null ? "—" : `${percent}%`}</span>
						</div>
					</div>
				</Row>
				<Row name="남은 크레딧" hint="한도에 도달하면 다음 주 초기화될 때까지 요청이 거절됩니다.">
					<span className="settings-value is-strong">{account === null ? UNKNOWN : formatCents(Math.max(0, limitCents - usedCents))}</span>
				</Row>
				<Row name="요청 한도" hint="요금제별 분당 요청 수입니다.">
					<span className="settings-value">{account === null ? UNKNOWN : `분당 ${account.requestsPerMinute}회`}</span>
				</Row>
			</Section>
		</>
	);
}
