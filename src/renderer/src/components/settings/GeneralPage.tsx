/**
 * Settings → 일반.
 *
 * App-level preferences write through `window.autorag.settings.set` (the same
 * store the Finder reads), and the document-language list edits the shared
 * AutoRAG config's global `languages` array through `LanguageSettings` (leaf
 * `configPatch` writes, so unknown config keys survive).
 */

import type { ReactElement } from "react";
import type { AppSettings, AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import { LanguageSettings } from "./LanguageSettings";
import { Row, Section, SettingsPageHead } from "./SettingsKit";
import { Switch } from "../primitives/Switch";

const autorag = window.autorag;

export function GeneralPage({
	appSettings,
	onAppSettingsChanged,
	snapshot,
	onSaved,
}: {
	readonly appSettings: AppSettings;
	readonly onAppSettingsChanged: (settings: AppSettings) => void;
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (snapshot: AutoRagConfigSnapshot) => void;
}): ReactElement {
	async function setApp(patch: Partial<AppSettings>): Promise<void> {
		onAppSettingsChanged(await autorag.settings.set(patch));
	}
	return (
		<>
			<SettingsPageHead title="일반" description="AutoRAG의 화면과 시작 방식을 설정합니다." />
			<Section title="화면">
				<Row name="화면 모드" hint="전체 화면에 같은 테마를 적용합니다.">
					<select className="linear-select" aria-label="화면 모드" value={appSettings.appearance} onChange={(event) => void setApp({ appearance: event.target.value as AppSettings["appearance"] })}>
						<option value="light">라이트</option>
						<option value="dark">다크</option>
					</select>
				</Row>
				<Row name="앱 언어" hint="메뉴와 설정에 사용할 언어입니다.">
					<select className="linear-select" aria-label="앱 언어" value={appSettings.language} onChange={(event) => void setApp({ language: event.target.value as AppSettings["language"] })}>
						<option value="ko">한국어</option>
						<option value="en">English</option>
						<option value="ja">日本語</option>
						<option value="zh">简体中文</option>
					</select>
				</Row>
			</Section>
			<Section title="Finder" description="Mac 파일 탐색 화면의 동작입니다.">
				<Row name="숨김 파일 보기" hint="점(.)으로 시작하는 시스템 파일을 Finder에 표시합니다.">
					<Switch checked={appSettings.showHiddenFiles} onChange={() => void setApp({ showHiddenFiles: !appSettings.showHiddenFiles })} ariaLabel="숨김 파일 보기" />
				</Row>
			</Section>
			<Section title="시작 및 업데이트">
				<Row name="로그인할 때 자동 실행" hint="컴퓨터를 켤 때 AutoRAG를 백그라운드에서 시작합니다.">
					<Switch checked={appSettings.launchAtLogin} onChange={() => void setApp({ launchAtLogin: !appSettings.launchAtLogin })} ariaLabel="로그인할 때 자동 실행" />
				</Row>
				<Row name="업데이트 자동 설치" hint="새 버전을 다음 앱 시작 때 자동으로 적용합니다.">
					<Switch checked={appSettings.autoInstallUpdates} onChange={() => void setApp({ autoInstallUpdates: !appSettings.autoInstallUpdates })} ariaLabel="업데이트 자동 설치" />
				</Row>
			</Section>
			<Section title="개인정보">
				<Row name="익명 사용 통계 보내기" hint="문서 내용을 제외한 성능 정보만 전송합니다.">
					<Switch checked={appSettings.telemetry} onChange={() => void setApp({ telemetry: !appSettings.telemetry })} ariaLabel="익명 사용 통계 보내기" />
				</Row>
			</Section>
			<Section title="문서 언어" description="문서를 읽고 검색할 때 우선 사용할 언어입니다.">
				<LanguageSettings snapshot={snapshot} path={["languages"]} name="문서 언어" hint="여러 개를 선택할 수 있습니다." onSaved={onSaved} fallback={["ko", "en"]} />
			</Section>
		</>
	);
}
