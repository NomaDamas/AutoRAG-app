import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { splitErrorDetails } from "../state/app-error";

/**
 * An error message as the person should meet it: the readable part, and the technical rest (status codes, JSON,
 * stack traces, internal setup instructions) behind "자세히 보기". A short plain message is shown as it is, with no
 * button. The rest is still there for whoever needs it to report a problem: selectable, in full.
 */
export function ErrorDetails({ message, className }: { readonly message: string; readonly className?: string }): ReactElement | null {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const { summary, details } = splitErrorDetails(message);
	if (summary === "" && details === null) return null;
	return (
		<div className="flex min-w-0 flex-col items-start gap-4">
			{summary === "" ? null : <span className={cn("select-text whitespace-pre-wrap break-words", className)}>{summary}</span>}
			{details === null ? null : (
				<>
					<button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-meta text-inherit underline underline-offset-2 opacity-80 hover:opacity-100" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
						{open ? t("appError.hideDetails") : t("appError.showDetails")}
					</button>
					{open ? <pre className="m-0 max-h-[180px] w-full select-text overflow-auto whitespace-pre-wrap break-all rounded-6 bg-window/60 px-8 py-6 font-mono text-caption leading-normal">{details}</pre> : null}
				</>
			)}
		</div>
	);
}
