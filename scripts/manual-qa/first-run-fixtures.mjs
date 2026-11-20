// Fixture documents for the first-run lanes: real-looking Korean and English files in the OS's Desktop and Documents.
//
// Every document is longer than the 200 letters a first-run question candidate needs (`MIN_EXCERPT_CHARS` in
// `src/main/first-run-service.ts`): the run holds `ready` until a question is proven against one of them, so a home
// whose files are all shorter ends on the retry screen, and a lane that waits for `ready` times out.
// A duplicate pair (`report.md`, `report (1).md`) gives dupey a family for the tour's duplicate steps.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./platform.mjs";

/** Writes the fixtures (never clobbering a file already there) and returns a function that removes what it wrote. */
export function writeFirstRunFixtures() {
	const HOME = homeDir();
	const DOCS = join(HOME, "Documents");
	const DESK = join(HOME, "Desktop");
	mkdirSync(DOCS, { recursive: true });
	mkdirSync(DESK, { recursive: true });
	const created = [];
	const put = (dir, name, text) => {
		const path = join(dir, name);
		if (existsSync(path)) return;
		writeFileSync(path, text);
		created.push(path);
	};
	put(
		DOCS,
		"3분기-회의록.md",
		"# 3분기 회의록\n\n일시: 10월 14일 오후 3시, 장소: 본사 4층 소회의실\n참석자: 한지우 팀장, 오세린 대리, 문태준 사원\n\n## 안건 1. 마케팅 비용\n마케팅 비용은 전분기보다 18% 줄었습니다. 외주 영상 제작을 사내 제작으로 바꾼 것이 가장 큰 이유입니다.\n\n## 안건 2. 신규 고객\n신규 고객은 412명 늘었습니다. 한지우 팀장은 연말까지 600명을 목표로 하자고 정리했습니다.\n\n## 결정\n오세린 대리가 11월 첫째 주까지 제휴 채널 세 곳의 견적을 받아 오기로 했습니다.\n",
	);
	put(
		DOCS,
		"q3-report.md",
		"# Q3 report\n\nPrepared by Daniel Ko for the leadership review on October 21.\n\n## Costs\nOperating cost fell 9% because we moved the warehouse contract from Harbor Logistics to Pinecrest Freight in July. The saving is about $41,000 a quarter.\n\n## Revenue\nRevenue grew 12% quarter over quarter, led by the subscription plan for small studios. Churn stayed at 2.4%.\n\n## Next quarter\nWe will hire two support engineers in Austin and renew the Pinecrest contract for another year.\n",
	);
	// A duplicate pair: the same quarterly summary with one number changed, so dupey groups them.
	const summary =
		"# Quarterly summary\n\nPrepared for the finance review on October 28.\n\nMarketing spend fell 18% against the prior quarter after the agency retainer ended in August. New customers grew by 412, most of them from the referral program that Mina Seo started in July.\n\nThe team agreed to keep the referral reward at 15 dollars and to review it again in January.\n";
	put(DOCS, "report.md", summary);
	put(DOCS, "report (1).md", summary.replace("412", "413"));
	put(
		DESK,
		"budget-notes.txt",
		"Budget notes for the third quarter.\n\nThe design team asked for 6,500 dollars for the new icon set and the packaging mockups. Hana Yoon approved 5,000 dollars and said the rest has to wait until the January planning meeting.\n\nThe offsite in Busan stays at 3,200 dollars, paid from the events line, not from marketing.\n",
	);
	return () => {
		for (const path of created) {
			try {
				rmSync(path, { force: true });
			} catch {
				// Already gone.
			}
		}
	};
}
