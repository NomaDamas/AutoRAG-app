/**
 * Settings → 웹 검색 / 검색 범위 / 문서 읽기 / 중복 파일 정리.
 *
 * Config-backed pages of the prototype IA. Every toggle/select writes a leaf
 * through the serialized `useConfigWriter` (webSearch/dupey/`fetch` keep the
 * upstream `false`/`enabled:true` block semantics), lists write their whole
 * array (arrays are replaced, never merged), and the document languages
 * reuse `LanguageSettings`.
 */

import { useState, type ReactElement } from "react";
import { Folder, Plus } from "lucide-react";
import { DEFAULT_CODE_FOLDER_NAMES, type AutoRagConfigSnapshot } from "../../../../shared/settings-contract";
import { LanguageSettings } from "./LanguageSettings";
import { Chips, Note, PromptModal, Row, Section, SettingsPageHead } from "./SettingsKit";
import { asRecord, boolOf, getAt, listOf, stringOf, useConfigWriter } from "./configSupport";
import { Switch } from "../primitives/Switch";

/** Web-search providers offered as the default provider in the web-search page. */
const WEBSEARCH_PROVIDERS: readonly { readonly id: string; readonly label: string }[] = [
	{ id: "gemini", label: "Gemini" },
	{ id: "anthropic", label: "Anthropic" },
	{ id: "codex", label: "OpenAI" },
	{ id: "xai", label: "xAI" },
	{ id: "perplexity", label: "Perplexity" },
	{ id: "parallel", label: "Parallel" },
	{ id: "searxng", label: "SearXNG" },
	{ id: "startpage", label: "Startpage" },
	{ id: "duckduckgo", label: "DuckDuckGo" },
	{ id: "ecosia", label: "Ecosia" },
	{ id: "google", label: "Google" },
	{ id: "mojeek", label: "Mojeek" },
	{ id: "public", label: "Public Web" },
];

/* ================================================================== Web == */

export function WebPage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { run, error } = useConfigWriter(onSaved);
	const web = getAt(snapshot.config, ["webSearch"]);
	const webObject = asRecord(web) ?? {};
	const webEnabled = web === undefined ? true : web !== false && boolOf(webObject.enabled) !== false;
	const provider = stringOf(webObject.provider);
	const rawFetch = webObject.fetch;
	const fetchObject = asRecord(rawFetch) ?? {};
	const fetchEnabled = rawFetch === undefined ? true : rawFetch !== false && boolOf(fetchObject.enabled) !== false;

	return (
		<>
			<SettingsPageHead title="웹 검색" description="최신 정보가 필요한 질문에 인터넷 검색 결과를 답변에 사용합니다." />
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			<Section title="웹 검색 사용">
				<Row name="웹 검색 사용" hint="질문이 검색 서비스로 전송될 수 있습니다.">
					<Switch
						checked={webEnabled}
						ariaLabel="웹 검색 사용"
						onChange={() => {
							if (webEnabled) void run([{ path: ["webSearch"], value: { ...webObject, enabled: false } }]);
							else void run([{ path: ["webSearch"], value: { ...(asRecord(web) ?? {}), enabled: true } }]);
						}}
					/>
				</Row>
				<Row name="검색 서비스" hint={webEnabled ? "기본값은 자동 선택입니다." : "웹 검색을 켜야 선택할 수 있습니다."}>
					<select
						className="linear-select"
						aria-label="검색 서비스"
						disabled={!webEnabled}
						value={provider}
						onChange={(event) => {
							const value = event.target.value;
							void run([value.length === 0 ? { path: ["webSearch", "provider"], remove: true } : { path: ["webSearch", "provider"], value }]);
						}}
					>
						<option value="">자동 선택</option>
						{WEBSEARCH_PROVIDERS.map((item) => (
							<option key={item.id} value={item.id}>{item.label}</option>
						))}
					</select>
				</Row>
				<Row name="웹페이지 내용 읽기" hint={webEnabled ? "검색 결과 링크의 본문을 답변에 참고합니다." : "웹 검색이 꺼져 있습니다."}>
					<Switch
						checked={webEnabled && fetchEnabled}
						disabled={!webEnabled}
						ariaLabel="웹페이지 내용 읽기"
						onChange={() => {
							if (fetchEnabled) void run([{ path: ["webSearch", "fetch"], value: { ...fetchObject, enabled: false } }]);
							else void run([{ path: ["webSearch", "fetch"], value: { ...(asRecord(rawFetch) ?? {}), enabled: true } }]);
						}}
					/>
				</Row>
			</Section>
		</>
	);
}

/* =============================================================== Scope == */

export function ScopePage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { run, error } = useConfigWriter(onSaved);
	const [addTarget, setAddTarget] = useState<"searchPaths" | "excludePaths" | null>(null);
	const searchPaths = listOf(getAt(snapshot.config, ["searchPaths"]));
	const excludePaths = listOf(getAt(snapshot.config, ["excludePaths"]));
	const fsearch = getAt(snapshot.config, ["fsearch"]);
	const watch = boolOf(getAt(snapshot.config, ["fsearch", "watch"])) ?? true;
	const appIndexing = asRecord(getAt(snapshot.config, ["appIndexing"])) ?? {};
	const storedCodeFolders = listOf(appIndexing.codeFolderNames);
	const codeFolderNames = (storedCodeFolders.length > 0 ? storedCodeFolders : DEFAULT_CODE_FOLDER_NAMES).filter((name) => !name.startsWith("."));

	function writeList(path: "searchPaths" | "excludePaths", next: readonly string[]): void {
		void run([next.length === 0 ? { path: [path], remove: true } : { path: [path], value: [...next] }]);
	}

	return (
		<>
			<SettingsPageHead title="검색 범위" description="AutoRAG가 읽고 검색할 폴더와 제외할 항목을 정합니다." />
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			<Section title="검색할 폴더" description="이 폴더의 내용을 AI 검색에 포함합니다.">
				<Row name="검색 폴더" hint="설정한 폴더 경로를 직접 입력해 추가·삭제합니다." stack>
					<div className="settings-path-list">
						{searchPaths.map((path, index) => (
							<div className="settings-path-line" key={`${path}-${index}`}>
								<Folder size={14} aria-hidden="true" focusable="false" />
								<span title={path}>{path}</span>
								<button type="button" className="linear-btn settings-btn-quiet" onClick={() => writeList("searchPaths", searchPaths.filter((_, i) => i !== index))}>삭제</button>
							</div>
						))}
						<button type="button" className="linear-btn settings-btn-quiet" onClick={() => setAddTarget("searchPaths")}>
							<Plus size={13} aria-hidden="true" focusable="false" />폴더 추가
						</button>
					</div>
				</Row>
				{searchPaths.length === 0 ? <Note>아직 검색 폴더가 없습니다. 추가하지 않으면 기본 검색 범위를 사용합니다.</Note> : null}
			</Section>
			<Section title="제외할 항목" description="검색하지 않을 폴더와 파일입니다.">
				<Note>개발용 폴더({codeFolderNames.join(", ")})와 .으로 시작하는 모든 폴더(.idea, .vscode, .cache 등)는 자동으로 제외되어 있습니다.</Note>
				<Row name="제외 목록" hint="이름이 일치하는 폴더·파일을 더 제외합니다." stack>
					<Chips
						items={excludePaths}
						onRemove={(index) => writeList("excludePaths", excludePaths.filter((_, i) => i !== index))}
						onAdd={() => setAddTarget("excludePaths")}
					/>
				</Row>
			</Section>
			<Section title="파일 포함 범위">
				<Row name="변경 자동 감지" hint={fsearch === false ? "파일 검색이 꺼져 있어 사용할 수 없습니다." : "파일 이름 검색 목록을 파일이 바뀔 때 갱신합니다. 문서 내용 색인은 인덱싱 화면에서 직접 새로 고칩니다."}>
					<Switch
						checked={watch}
						disabled={fsearch === false}
						ariaLabel="변경 자동 감지"
						onChange={() => void run([{ path: ["fsearch", "watch"], value: !watch }])}
					/>
				</Row>
			</Section>
			{addTarget !== null ? (
				<PromptModal
					title={addTarget === "searchPaths" ? "검색 폴더 추가" : "제외 항목 추가"}
					description={addTarget === "searchPaths" ? "검색에 포함할 폴더 경로를 입력하세요." : "검색에서 제외할 폴더·파일 이름을 입력하세요."}
					label={addTarget === "searchPaths" ? "폴더 경로" : "항목"}
					placeholder={addTarget === "searchPaths" ? "예: ~/Documents" : "예: node_modules"}
					confirmLabel="추가"
					onCancel={() => setAddTarget(null)}
					onSubmit={(value) => {
						writeList(addTarget, [...(addTarget === "searchPaths" ? searchPaths : excludePaths), value]);
						setAddTarget(null);
					}}
				/>
			) : null}
		</>
	);
}

/* ============================================================= Reading == */

export function ReadingPage({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const { error } = useConfigWriter(onSaved);
	return (
		<>
			<SettingsPageHead title="문서 읽기" description="문서를 읽고 검색할 때 우선 사용할 언어를 설정합니다." />
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			<Section title="문서 언어" description="문서 내용을 읽고 검색할 때 우선 사용할 언어입니다.">
				<LanguageSettings snapshot={snapshot} path={["languages"]} name="문서 언어" hint="여러 개를 선택할 수 있습니다." onSaved={onSaved} fallback={["ko", "en"]} />
			</Section>
		</>
	);
}

/* ========================================================== Duplicates == */

const DUPEY_INTERVALS: readonly { readonly value: number; readonly label: string }[] = [
	{ value: 15, label: "15분" },
	{ value: 30, label: "30분" },
	{ value: 60, label: "1시간" },
	{ value: 180, label: "3시간" },
	{ value: 360, label: "6시간" },
	{ value: 720, label: "12시간" },
	{ value: 1440, label: "하루" },
];

export function DuplicatesPage({
	snapshot,
	onSaved,
	dupeyInterval,
	onDupeyInterval,
}: {
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (next: AutoRagConfigSnapshot) => void;
	readonly dupeyInterval: number;
	readonly onDupeyInterval: (minutes: number) => void;
}): ReactElement {
	const { run, error } = useConfigWriter(onSaved);
	const excludeExact = boolOf(getAt(snapshot.config, ["excludeExactDuplicates"])) ?? true;
	const dupey = getAt(snapshot.config, ["dupey"]);
	const dupeyObject = asRecord(dupey) ?? {};
	const dupeyEnabled = dupey === undefined ? true : dupey !== false && boolOf(dupeyObject.enabled) !== false;
	return (
		<>
			<SettingsPageHead title="중복 파일 정리" description="검색 결과에 같은 내용이 반복해서 나타나지 않도록 정리합니다." />
			{error !== null ? <div className="settings-error" role="alert">{error}</div> : null}
			<Section title="검색 결과 정리">
				<Row name="완전히 같은 파일은 하나만" hint="내용이 같은 파일은 가장 최근 것만 보여줍니다.">
					<Switch checked={excludeExact} ariaLabel="완전히 같은 파일은 하나만" onChange={() => void run([{ path: ["excludeExactDuplicates"], value: !excludeExact }])} />
				</Row>
				<Row name="비슷한 버전 묶기" hint="보고서_최종, 보고서_최종2처럼 관련 파일을 묶어 보여줍니다.">
					<Switch
						checked={dupeyEnabled}
						ariaLabel="비슷한 버전 묶기"
						onChange={() => {
							if (dupeyEnabled) void run([{ path: ["dupey"], value: { ...dupeyObject, enabled: false } }]);
							else void run([{ path: ["dupey"], value: { ...(asRecord(dupey) ?? {}), enabled: true } }]);
						}}
					/>
				</Row>
				<Row name="검사 주기" hint="파일 변화를 다시 확인하는 주기입니다.">
					<select className="linear-select" aria-label="검사 주기" value={String(dupeyInterval)} onChange={(event) => onDupeyInterval(Number(event.target.value))}>
						{DUPEY_INTERVALS.map((item) => (
							<option key={item.value} value={item.value}>{item.label}</option>
						))}
					</select>
				</Row>
			</Section>
		</>
	);
}
