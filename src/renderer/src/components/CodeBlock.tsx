import { useMemo, type ReactElement } from "react";
import { highlightCode } from "../../../preview/ui/highlight";

/**
 * A fenced code block of an AI Search answer or an evidence excerpt, coloured
 * by the fence's language with the same grammars and palette Quick Look uses
 * (`preview/ui/syntax.css`). A fence with no language, or one the app has no
 * grammar for, renders as plain text.
 */
export function CodeBlock({ text, language, className }: { readonly text: string; readonly language: string | null; readonly className: string }): ReactElement {
	const html = useMemo(() => highlightCode(text, language), [text, language]);
	return (
		<pre className={`hl-code ${className}`} data-language={language ?? undefined}>
			{/* highlightCode escapes the source; the only markup it adds is highlight.js's span tokens. */}
			<code dangerouslySetInnerHTML={{ __html: html }} />
		</pre>
	);
}
