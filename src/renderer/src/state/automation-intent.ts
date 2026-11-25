/**
 * Whether a chat message only asks to make an automation ("자동화 만들어줘", "자동화 만들고 싶어", "create an
 * automation"), so the chat can answer with the 새 자동화 card at once instead of a search. A message that already
 * says what the automation should do ("다운로드에 PDF가 오면 요약하는 자동화 만들어줘") is not one: the agent
 * reads it and drafts that rule itself.
 */
export function isAutomationRequest(raw: string): boolean {
	const text = raw.normalize("NFKC").toLowerCase().trim();
	const tight = text.replace(/[\s.,!?~…。！？、'"]+/gu, "");
	if (tight.length === 0) return false;
	if (tight.length <= 24 && [...KOREAN, ...JAPANESE, ...CHINESE].some((pattern) => pattern.test(tight))) return true;
	const words = text.replace(/[.,!?~…]+/gu, " ").replace(/\s+/gu, " ").trim();
	return ENGLISH.some((pattern) => pattern.test(words));
}

const KOREAN: readonly RegExp[] = [
	// 자동화 만들어줘 · 새 자동화 하나 추가하고 싶어요 · 자동화를 좀 만들어 주세요 · 자동화 만들기
	/^(나|저)?(도)?(새|새로운)?자동화(규칙)?(를|을|도)?(좀|하나|하나만|한개)?(좀)?(새로)?(만들|추가|생성|설정|등록)[가-힣]{0,7}$/u,
	// 새 자동화 · 자동화하고 싶어 · 자동화할래
	/^새(로운)?자동화$/u,
	/^자동화(하기|할래|할래요|하고싶어|하고싶어요|하고싶습니다|하고싶은데|해줘|해주세요)$/u,
];

const JAPANESE: readonly RegExp[] = [
	// 自動化を作って · 新しい自動化を追加したい · 自動化を作成
	/^(新しい|新規)?自動化(ルール)?(を)?(作|つく|追加|設定|登録|作成)[ぁ-んー]{0,8}$/u,
	/^自動化(したい|してほしい|して|してください)$/u,
];

const CHINESE: readonly RegExp[] = [
	// 创建自动化 · 我想新建一个自动化 · 帮我建个自动化吧
	/^(我|请|請|帮我|幫我)?(想|要|想要)?(创建|創建|新建|建|做|添加|設置|设置|建立|新增)(一个|一個|个|個)?(新的)?(自动化|自動化)(规则|規則)?(吧|吗|嗎|呢)?$/u,
	/^(自动化|自動化)(创建|創建|新建)$/u,
];

const ENGLISH: readonly RegExp[] = [
	// create an automation · i want to make a new automation · can you set up an automation for me please
	/^(please )?((can|could|would) you |i (want|would like|'d like|wanna|need) to |let'?s |help me |i want |i need )?(please )?(create|make|add|set up|setup|build|start)( me)?( an?| a new| new| another| one)? automation( rule)?( for me)?( please)?$/u,
	/^(a )?new automation$/u,
	/^(i want to |let'?s )?automate something$/u,
];
