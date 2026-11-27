/**
 * Whether a chat message only asks to make an automation ("자동화 만들어줘", "자동화 만들고 싶음", "create an
 * automation"), or a right-click one ("우클릭 자동화 만들고 싶어", "매직 액션 추가해줘", "create a right-click action"),
 * so the chat can answer with the 새 자동화 card at once instead of a search — set to 우클릭하면 for the second kind.
 * A message that already says what the automation should do ("다운로드에 PDF가 오면 요약하는 자동화 만들어줘") is
 * not one: the agent reads it and drafts that rule itself.
 */
export type AutomationRequestKind = "rule" | "rightClick";

export function automationRequestKind(raw: string): AutomationRequestKind | null {
	const text = raw.normalize("NFKC").toLowerCase().trim();
	const tight = text.replace(/[\s.,!?~…。！？、'"·・]+/gu, "");
	if (tight.length === 0) return null;
	if (tight.length <= 30) {
		if ([...KOREAN_RIGHT_CLICK, ...JAPANESE_RIGHT_CLICK, ...CHINESE_RIGHT_CLICK].some((pattern) => pattern.test(tight))) return "rightClick";
		if ([...KOREAN, ...JAPANESE, ...CHINESE].some((pattern) => pattern.test(tight))) return "rule";
	}
	const words = text.replace(/[.,!?~…]+/gu, " ").replace(/\s+/gu, " ").trim();
	if (ENGLISH_RIGHT_CLICK.some((pattern) => pattern.test(words))) return "rightClick";
	if (ENGLISH.some((pattern) => pattern.test(words))) return "rule";
	return null;
}

export function isAutomationRequest(raw: string): boolean {
	return automationRequestKind(raw) !== null;
}

/** Asking for it: 만들어줘 · 만들고 싶음 · 추가할래 · 하나 넣어 주세요 · 만들기 … */
const KO_MAKE = "(만들|추가|생성|설정|등록|넣)[가-힣]{0,8}";
/** What comes before: 나도 · 새 · 새로운 · 나만의 */
const KO_LEAD = "(나|저)?(도)?(새|새로운|나만의|내)?";
/** What comes between it and asking: 를 · 좀 · 하나 · 하나만 · 한 개 · 새로 */
const KO_FILL = "(를|을|도|에|으로|로)?(좀|하나|하나만|한개)?(좀)?(새로)?";

const KOREAN_RIGHT_CLICK: readonly RegExp[] = [
	// 우클릭 자동화 만들고싶음 · 우클릭 메뉴에 항목 추가하고 싶어 · 오른쪽 클릭 버튼 만들어줘 · 매직 액션 하나 만들어 주세요
	new RegExp(`^${KO_LEAD}(우클릭|오른쪽클릭|마우스오른쪽(버튼)?|컨텍스트)(메뉴)?(용|에|에서)?(새)?(자동화|항목|버튼|기능|액션|매직액션)?${KO_FILL}${KO_MAKE}$`, "u"),
	new RegExp(`^${KO_LEAD}매직액션${KO_FILL}${KO_MAKE}$`, "u"),
	/^(새|새로운)?(우클릭자동화|매직액션)$/u,
];

const KOREAN: readonly RegExp[] = [
	// 자동화 만들어줘 · 새 자동화 하나 추가하고 싶어요 · 자동화를 좀 만들어 주세요 · 자동화 만들고싶음 · 나만의 자동화 만들래
	new RegExp(`^${KO_LEAD}자동화(규칙)?${KO_FILL}${KO_MAKE}$`, "u"),
	// 새 자동화 · 자동화하고 싶어 · 자동화할래 · 자동화하고싶음
	/^새(로운)?자동화$/u,
	/^자동화(하기|할래|할래요|하고싶어|하고싶어요|하고싶음|하고싶습니다|하고싶은데|해줘|해주세요|해보고싶어)$/u,
];

const JAPANESE_RIGHT_CLICK: readonly RegExp[] = [
	// 右クリックの自動化を作りたい · 右クリックメニューに項目を追加して · マジックアクションを作って
	/^(新しい)?(右クリック(メニュー)?|コンテキストメニュー)(の|に|用の)?(新しい)?(自動化|項目|ボタン|アクション)?(を)?(作|つく|追加|設定|登録|作成)[ぁ-んー]{0,8}$/u,
	/^(新しい)?マジックアクション(を)?(作|つく|追加|設定|登録|作成)[ぁ-んー]{0,8}$/u,
];

const JAPANESE: readonly RegExp[] = [
	// 自動化を作って · 新しい自動化を追加したい · 自動化を作成
	/^(新しい|新規)?自動化(ルール)?(を)?(作|つく|追加|設定|登録|作成)[ぁ-んー]{0,8}$/u,
	/^自動化(したい|してほしい|して|してください)$/u,
];

const CHINESE_RIGHT_CLICK: readonly RegExp[] = [
	// 我想创建右键自动化 · 帮我添加一个右键菜单项 · 新建魔法操作
	/^(我|请|請|帮我|幫我)?(想|要|想要)?(创建|創建|新建|建|做|添加|設置|设置|建立|新增)(一个|一個|个|個)?(新的)?(右键|右鍵)(菜单|選單)?(的)?(自动化|自動化|项|項|按钮|按鈕|操作)?(吧|吗|嗎|呢)?$/u,
	/^(我|请|請|帮我|幫我)?(想|要|想要)?(创建|創建|新建|建|做|添加|新增)(一个|一個|个|個)?(新的)?(魔法操作)(吧|吗|嗎|呢)?$/u,
];

const CHINESE: readonly RegExp[] = [
	// 创建自动化 · 我想新建一个自动化 · 帮我建个自动化吧
	/^(我|请|請|帮我|幫我)?(想|要|想要)?(创建|創建|新建|建|做|添加|設置|设置|建立|新增)(一个|一個|个|個)?(新的)?(自动化|自動化)(规则|規則)?(吧|吗|嗎|呢)?$/u,
	/^(自动化|自動化)(创建|創建|新建)$/u,
];

/** can you · i want to · let's · help me … (please) */
const EN_LEAD = "^(please )?((can|could|would) you |i (want|would like|'d like|wanna|need) to |let'?s |help me |i want |i need )?(please )?";
const EN_TAIL = "( for me)?( please)?$";

const ENGLISH_RIGHT_CLICK: readonly RegExp[] = [
	// create a right-click automation · i want to add a right click menu item · make a magic action please
	new RegExp(`${EN_LEAD}(create|make|add|set up|setup|build)( me)?( an?| a new| new| another| one)? (right[- ]?click( menu)?|context menu)( automation| action| item| button| entry)?${EN_TAIL}`, "u"),
	new RegExp(`${EN_LEAD}(create|make|add|set up|setup|build)( me)?( an?| a new| new| another| one)? magic action${EN_TAIL}`, "u"),
	/^(a )?new (right[- ]?click (automation|action)|magic action)$/u,
];

const ENGLISH: readonly RegExp[] = [
	// create an automation · i want to make a new automation · can you set up an automation for me please
	new RegExp(`${EN_LEAD}(create|make|add|set up|setup|build|start)( me)?( an?| a new| new| another| one)? automation( rule)?${EN_TAIL}`, "u"),
	/^(a )?new automation$/u,
	/^(i want to |let'?s )?automate something$/u,
];
