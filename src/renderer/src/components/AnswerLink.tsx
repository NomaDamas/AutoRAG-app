/**
 * An http(s) link in an AI Search answer or an evidence excerpt.
 *
 * The Finder window never navigates to model output: every click, modified
 * click (Cmd/Ctrl/Shift), and middle click is cancelled and the URL goes to the
 * OS browser through `onOpenUrl`. The `href` stays so the element is a real
 * link (keyboard focus, Enter, screen readers); the parser only produces
 * `http(s)` URLs, so no other scheme reaches it.
 */

import type { MouseEvent, ReactElement, ReactNode } from "react";

/** A bold label keeps the link colour: the surrounding `[&_strong]:text-ink` rules would otherwise win. */
const LINK = "text-accent-text underline underline-offset-2 break-all cursor-pointer hover:text-accent-text-strong [&_strong]:text-inherit!";

export function AnswerLink({
	url,
	onOpenUrl,
	children,
}: {
	readonly url: string;
	readonly onOpenUrl: (url: string) => void;
	readonly children: ReactNode;
}): ReactElement {
	return (
		<a
			href={url}
			className={LINK}
			draggable={false}
			onClick={(event: MouseEvent) => {
				event.preventDefault();
				onOpenUrl(url);
			}}
			onAuxClick={(event: MouseEvent) => {
				event.preventDefault();
				if (event.button === 1) onOpenUrl(url);
			}}
		>
			{children}
		</a>
	);
}
