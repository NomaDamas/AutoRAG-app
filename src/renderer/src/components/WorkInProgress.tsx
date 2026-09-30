import type { ReactElement } from "react";

/** Placeholder for a place whose view is not built yet (People/Contacts). */
export function WorkInProgress({ title }: { readonly title: string }): ReactElement {
	return (
		<div className="wip-view" role="status">
			<h2 className="wip-view__title">준비중 · Work in progress</h2>
			<p className="wip-view__body">{title} 기능을 만들고 있는 중입니다. 완성되면 이곳에서 확인할 수 있습니다.</p>
		</div>
	);
}
