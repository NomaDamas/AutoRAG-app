/* The "해설" panel under the prototype: design rules, the kinds table, what was checked in code, what was not. */
"use strict";

function notesHtml() {
	const v = (t) => `<span class="verified">코드로 확인</span>${t}`;
	const u = (t) => `<span class="unverified">미확인</span>${t}`;
	return `
	<section><h2>설계 한 줄</h2>
		<p>멈춤은 별도의 실패 화면이 아니라 <b>같은 인덱싱 화면의 일시정지 상태</b>입니다. 사용자가 그 순간 알아야 하는 것은 셋뿐입니다. <b>무슨 일인지, 뭘 누르면 되는지, 안 고치고 가는 길이 있는지.</b></p></section>

	<section><h2>정보량 규칙</h2><ul>
		<li><b>1. 화면에는 5개만 둡니다.</b> 아이콘 · 제목(한 줄) · 이유(한 줄) · 버튼 하나 · 작은 링크 최대 둘. 알약, 메타 줄, 단계 표시줄, 카드, 상태 행, 안내문, 펼침은 뺐습니다.</li>
		<li><b>2. 버튼은 하나입니다.</b> Enter가 누르는 버튼이고, 나머지 출구는 링크로 내렸습니다. 링크 중 하나는 항상 “일단 Dazzi 열기”입니다.</li>
		<li><b>3. 이유는 한 줄입니다.</b> 그 줄이 곧 상태 표시 자리입니다. 자동 재시도 카운트다운(“8초 뒤 자동으로 다시 시도해요”), 같은 이유로 반복(“같은 이유로 또 멈췄어요”), 연결 복구(“연결됐어요 · 이어서 해요”)가 모두 이 줄 하나를 바꿉니다.</li>
		<li><b>4. 얼마나 했는지는 숫자 없이 점 하나로.</b> 막대에 멈춘 지점을 표시합니다. 아직 아무것도 읽기 전이면(설정·폴더 오류) 막대 자체를 숨깁니다. “남은 시간 계산 중”은 실패한 실행에 나오지 않습니다(#283 문제 4).</li>
		<li><b>5. 원문과 코드는 화면에 두지 않습니다.</b> 사용자가 알아야 할 정보가 아닙니다. 진단은 앱 로그에만 남깁니다. 건너뛴 파일도 개수 한 줄이 전부입니다.</li>
		<li><b>6. 같은 이유로 또 멈추면 버튼이 바뀝니다.</b> 원인 미확인에서 “다시 시도”를 누르면 두 번째 멈춤에서 “임베딩 방식 바꾸기”가 버튼이 됩니다.</li>
		<li><b>7. 앱으로 넘어가도 문제는 남습니다.</b> 사이드바 하단 블록, 파일 목록 위 배너(제목 한 줄 + 버튼 하나), 설정 &gt; 인덱싱 카드. 지금 앱은 실패를 15초 뒤 지웁니다(<code>FAILED_LINGER_MS</code>).</li></ul></section>

	<section><h2>종류와 화면 (이슈 표 + 원인 미확인)</h2>
	<table><tr><th>종류</th><th>시안 버튼</th><th>누르는 버튼</th><th>자동으로 하는 일</th><th>앱이 구분하는 근거</th></tr>
		<tr><td>설정 오류</td><td>설정 오류</td><td>임베딩 방식 바꾸기</td><td>없음 (문서를 읽기 전에 멈춤)</td><td><code>embedder-preflight-failed</code> (PR #274, 아직 미병합)</td></tr>
		<tr><td>일시 오류</td><td>일시 오류</td><td>지금 다시 시도</td><td>8초마다 자동 재시도, 최대 6번</td><td>코드가 아니라 메시지: <code>isEmbeddingTimeout()</code>(embedding-batch.ts) + <code>checkNetwork()</code></td></tr>
		<tr><td>환경 문제</td><td>환경 · 폴더 / 디스크</td><td>다시 확인 / 이어서 받기</td><td>폴더는 3초마다 확인, 모델은 이어받기</td><td>폴더: <code>search-root-unavailable</code>. 디스크: 코드가 없어 <code>modelDownloadFailed</code> 문자열의 <code>ENOSPC</code>를 읽어야 합니다(새 진단 코드 제안).</td></tr>
		<tr><td>원인 미확인</td><td>원인 미확인</td><td>다시 시도</td><td>없음</td><td>위에 없는 모든 것</td></tr>
		<tr><td>부분 실패</td><td>부분 실패</td><td>Dazzi 열기 (끝난 화면)</td><td>다음 새로 고침에서 재시도</td><td><code>parse-killed</code>, <code>files-left-out</code>, <code>minsync-file-skipped</code></td></tr></table></section>

	<section><h2>이슈의 결정 질문 3개: 이 시안의 선택</h2><ul>
		<li><b>1. 키워드로만 시작을 허용할까?</b> 허용합니다. 시안에서는 “일단 Dazzi 열기”가 그 역할을 합니다. 앱이 열리면서 키워드 전용으로 새로 한 번 돌립니다(<code>appIndexing.semanticSearch=false</code> → <code>parsed + jikji</code>). 이미 읽은 문서는 증분이라 다시 읽지 않습니다. ${v("<code>methodsForSemantic</code>가 <code>[parsed, minsync]</code>를 <code>[parsed, jikji]</code>로 바꿉니다(semantic-policy.ts).")} ${u("임베딩 실패 직후 Jikji가 이미 끝나 있는지는 확인하지 못했습니다. 그래서 ‘이미 됐다’고 가정하지 않고 ‘다시 돌린다’로 설계했습니다.")}</li>
		<li><b>2. 사유 분류는 앱이 문자열을 추측할까?</b> 추측하지 않습니다. 앱이 직접 내보내는 <code>diagnostics[].code</code>만 분류하고 나머지는 “원인 미확인 + 원문”입니다. ${v("<code>onboarding-service.ts</code>는 <code>settle(result.ok, result.error)</code>만 받아 diagnostics를 버립니다.")} 402 같은 상태 코드는 메시지 문자열이 아니라 진단에 구조화된 필드로 실어야 합니다(제안).</li>
		<li><b>3. 고치는 곳은 온보딩 안일까, 설정일까?</b> <b>둘 다, 같은 모양으로.</b> 임베딩은 온보딩의 임베딩 단계를 다시 열고(‘돌아가기’ 한 번), 폴더 제외는 그 자리에서 처리합니다. 앱이 열린 뒤에는 같은 선택지를 설정 &gt; 인덱싱에서 씁니다.</li></ul></section>

	<section><h2>코드로 확인한 것</h2><ul>
		<li>${v("실패하면 <code>.ix-bg-start</code>가 사라지고 인덱싱 단계에는 하단 바가 없습니다. 출구가 없다는 이슈 설명과 일치합니다.")}</li>
		<li>${v("앱을 다시 켜면 <code>stepId==='indexing'</code> 효과가 마운트 때 <code>startIndexing()</code>을 호출합니다. 실패 상태가 저장되지 않아 같은 실패를 조용히 반복합니다(읽어서 확인, 실행은 안 함).")}</li>
		<li>${v("모델 내려받기는 <code>Range</code>로 이어받습니다(<code>model-download.ts</code>).")}</li>
		<li>${v("컨텍스트 메뉴의 <code>retryIndex</code>는 핸들러가 비어 있고(<code>useFinderController.ts</code>), <code>indexFailed</code>를 켜는 곳도 없습니다. 앱 안 재시도는 아직 없습니다.")}</li>
		<li>${v("디스크 부족(<code>ENOSPC</code>)을 따로 다루는 코드는 없습니다. 지금은 <code>modelDownloadFailed</code> 안의 문자열로만 나옵니다.")}</li>
		<li>${v("온보딩 브리지에 <code>checkNetwork()</code>가 이미 있어 일시 오류의 ‘연결 확인’에 쓸 수 있습니다.")}</li></ul></section>

	<section><h2>확인하지 못한 것 · 시안의 가정</h2><ul>
		<li>${u("“읽은 문서는 그대로예요”: 부분 파싱은 증분이고 MinSync의 <code>progress.jsonl</code>이 충돌 복구 로그인 것은 확인했지만, 실패 뒤 재시도가 커밋된 파일을 건너뛰는지는 실행해 보지 못했습니다. 임베딩 방식을 바꾸면 identity가 달라져 전체 재색인이므로, 그때는 임베딩이 처음부터입니다.")}</li>
		<li>${u("숫자(12,480개, 4,120개, 22개, 0.2 GB)와 402 응답 내용은 예시입니다.")}</li>
		<li>${u("자동 재시도 간격(8초×6, 3초)과 ‘두 번째에 버튼 교체’ 규칙은 제안값입니다.")}</li>
		<li>${u("앱 안 화면은 토큰으로 흉내 낸 목업입니다. 새 요소는 ‘파일 목록 위 배너’와 ‘설정 안 임베딩 방식 선택’입니다.")}</li>
		<li>${u("이슈의 ‘실패한 단계를 단계 표시줄에 반영’과 ‘접어 둔 자세히’는 두지 않았습니다. 멈춘 곳은 막대의 점 하나가 전부입니다. 유지할지는 정해야 합니다.")}</li></ul></section>

	<section><h2>이 시안을 코드로 옮기면 (이 시안은 코드를 바꾸지 않습니다)</h2><ul>
		<li><code>onboarding-service.ts</code>: <code>settle</code>에 diagnostics를 넘기고, <code>IndexingStatus</code>에 <code>failure: { kind, code, stage, kept } | null</code>와 <code>skipped</code> 요약을 추가합니다. <code>state.json</code>에 마지막 실패를 저장해 재실행 때 한 번만 조용히 재시도한 뒤 같은 화면을 보여줍니다.</li>
		<li><code>IndexingScreen.tsx</code>: <code>failed</code> 분기를 이 시안의 멈춤 화면으로 교체하고, 끝난 화면에 건너뛴 파일 한 줄을 붙입니다. 새 CSS는 <code>onboarding.css</code> 맨 아래 ‘States the prototype has no design for’에 넣습니다(<code>prototype.css</code> 2부가 그대로 옮겨집니다).</li>
		<li>앱 안: 사이드바 블록은 실패일 때 15초 제한을 없애고(해결되거나 닫을 때까지), 파일 목록 배너와 <code>retryIndex</code> 핸들러를 만듭니다.</li>
		<li>번역: 문구가 짧아져 키가 줄었습니다. ko/en/ja/zh 네 파일에 같은 키로 추가합니다. 이 시안의 한국어는 아직 i18n 키가 아닙니다.</li></ul></section>`;
}
