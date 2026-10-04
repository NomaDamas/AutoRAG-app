import type { ReactElement } from "react";

/**
 * One Finder grouping section header (issue #47): the label the toolbar Group
 * control splits the rows under. The block is exactly `GROUP_HEADER_HEIGHT`
 * tall — the shared geometry in `state/grouping` computes scroll offsets and
 * virtualization windows from that number, so this must not grow.
 */
export function GroupHeader({
	label,
}: {
	readonly label: string;
}): ReactElement {
	return (
		<div
			className="group-header flex h-[40px] flex-none items-end px-12 pb-8 select-none"
			aria-hidden="true"
		>
			<span className="text-tile font-semibold text-ink-muted uppercase tracking-[0.04em]">
				{label}
			</span>
		</div>
	);
}
