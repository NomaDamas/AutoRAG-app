/**
 * Settings → 내 계정 / 구독 및 사용량.
 *
 * These two pages mirror the prototype's structure (sidebar group 계정) but are
 * honest about what the app actually knows: there is no AutoRAG account or
 * usage backend, so every value is either a static product fact or explicitly
 * "확인할 수 없음". Plan changes, top-ups and payment all leave the app for the
 * AutoRAG billing web page through `window.autorag.fs.openUrl` (guarded — when
 * the bridge is absent the links render disabled instead of faking a request).
 */

import type { ReactElement } from "react";
import { ExternalLink } from "lucide-react";
import { Note, Row, Section, SettingsPageHead } from "./SettingsKit";

const BILLING_BASE = "https://autorag.ai/billing";

function ExternalButton({ url, label, disabled = false }: { readonly url: string; readonly label: string; readonly disabled?: boolean }): ReactElement {
	return (
		<button
			type="button"
			className="linear-btn"
			disabled={disabled}
			onClick={() => {
				const open = window.autorag?.fs?.openUrl;
				if (typeof open === "function") void open(url);
			}}
		>
			{label}
			<ExternalLink size={13} aria-hidden="true" focusable="false" />
		</button>
	);
}

const EXTERNAL_LINKS_AVAILABLE = typeof window.autorag?.fs?.openUrl === "function";

export function AccountPage(): ReactElement {
	const available = EXTERNAL_LINKS_AVAILABLE;
	return (
		<>
			<SettingsPageHead title="내 계정" description="온보딩에서 로그인한 AutoRAG 계정입니다." />
			<Section title="프로필">
				<Row name="AutoRAG 계정" hint="이 앱은 AutoRAG 계정 정보를 읽지 않습니다. 로그인·프로필은 온보딩에서 관리합니다.">
					<span className="settings-value">
						<span className="settings-dot is-warn" aria-hidden="true" />
					</span>
					<span className="settings-value">연결된 계정 정보 없음</span>
				</Row>
				<Row name="이름" hint="AutoRAG에 표시되는 이름입니다. 이 앱에서는 바꿀 수 없습니다.">
					<span className="settings-value">확인할 수 없음</span>
				</Row>
				<Row name="이메일" hint="로그인한 계정의 이메일입니다. 이 앱에서는 바꿀 수 없습니다.">
					<span className="settings-value">확인할 수 없음</span>
				</Row>
				<Note>
					계정 데이터 백엔드가 아직 없어 앱 안에서는 이름·이메일을 표시하거나 수정하지 않습니다. 계정 관리는 AutoRAG 웹에서 진행하세요.
				</Note>
			</Section>
			<Section title="계정 삭제" description="계정과 구독, 사용 기록의 삭제는 AutoRAG 웹에서 진행합니다.">
				<Row name="계정 삭제" hint="계정과 구독, 사용 기록을 영구히 삭제합니다. 이 Mac에 있는 문서와 검색 색인은 지워지지 않습니다.">
					<ExternalButton url={`${BILLING_BASE}/portal`} label="계정 관리 열기" disabled={!available} />
				</Row>
				{available ? null : <Note>브라우저 열기 기능을 사용할 수 없어 링크가 비활성화되었습니다.</Note>}
			</Section>
		</>
	);
}

interface PlanTier {
	readonly id: string;
	readonly label: string;
	readonly price: string;
	readonly perks: string;
}

/** Static product copy (same tiers the prototype shows); never a usage fact. */
const PLAN_TIERS: readonly PlanTier[] = [
	{ id: "free", label: "AutoRAG Free", price: "무료", perks: "기본 모델 · 월 1,000 크레딧" },
	{ id: "air", label: "AutoRAG Air", price: "월 $4", perks: "모든 기본 모델 · 월 5,000 크레딧" },
	{ id: "pro", label: "AutoRAG Pro", price: "월 $20", perks: "모든 모델 · 월 20,000 크레딧 · 우선 처리" },
];

export function PlanPage(): ReactElement {
	const available = EXTERNAL_LINKS_AVAILABLE;
	return (
		<>
			<SettingsPageHead title="구독 및 사용량" description="AutoRAG 요금제와 이번 달 AI 사용량을 확인합니다." />
			<Section title="현재 요금제">
				<Row name="현재 요금제" hint="이 앱은 AutoRAG 구독 상태를 읽지 않습니다. 요금제 변경과 결제는 AutoRAG 결제 웹페이지에서 진행합니다.">
					<span className="settings-value is-strong">확인할 수 없음</span>
				</Row>
				{PLAN_TIERS.map((tier) => (
					<Row key={tier.id} name={tier.label} hint={`${tier.price} · ${tier.perks}`}>
						<ExternalButton url={`${BILLING_BASE}/plans?plan=${tier.id}`} label="요금제 보기" disabled={!available} />
					</Row>
				))}
				<Row name="결제 관리" hint="결제 수단, 영수증, 구독 해지는 결제 포털에서 관리합니다.">
					<ExternalButton url={`${BILLING_BASE}/portal`} label="결제 포털 열기" disabled={!available} />
				</Row>
			</Section>
			<Section title="이번 달 사용량">
				<Row name="AI 사용량" hint="AutoRAG 요금제 모델을 쓸 때 차감됩니다. 이 앱에서는 사용량을 읽을 수 없습니다." stack>
					<div className="settings-usage">
						<div className="settings-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} aria-label="사용량 표시 불가">
							<span style={{ width: "0%" }} />
						</div>
						<div className="settings-usage-legend">
							<span>사용량 데이터를 불러올 수 없습니다</span>
							<span>—</span>
						</div>
					</div>
				</Row>
				<Row name="남은 크레딧" hint="사용량 백엔드가 없어 표시할 수 없습니다.">
					<span className="settings-value is-strong">확인할 수 없음</span>
				</Row>
				<Row name="추가 사용량 구매" hint="요금제 한도를 다 쓰면 추가 크레딧에서 차감합니다.">
					<ExternalButton url={`${BILLING_BASE}/credits`} label="추가 구매" disabled={!available} />
				</Row>
				<Note>요금제 수치는 AutoRAG 제품 안내이며, 이 앱에서 확인된 사용량 값이 아닙니다.</Note>
			</Section>
		</>
	);
}
