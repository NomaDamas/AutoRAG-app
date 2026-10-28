import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

/**
 * Raw error text is always hidden by default behind "자세히 보기" ("Show details"):
 * the person sees only the plain-words title and hint, while the full original
 * message stays one click away for anyone who wants to inspect or report it.
 */
export function ErrorDetails({ message, className }: { readonly message: string; readonly className?: string }): ReactElement | null {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const trimmed = message.trim();
	if (trimmed === "") return null;
	return (
		<div className={cn("mt-2 flex min-w-0 flex-col items-start gap-4", className)}>
			<button
				type="button"
				className="cursor-pointer border-0 bg-transparent p-0 text-meta text-ink-muted underline underline-offset-2 transition-colors duration-(--dur-color) ease-out hover:text-ink"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
			>
				{open ? t("appError.hideDetails") : t("appError.showDetails")}
			</button>
			{open ? (
				<pre className="m-0 max-h-[180px] w-full select-text overflow-auto whitespace-pre-wrap break-all rounded-6 border border-border-divider bg-chrome px-10 py-8 text-left font-mono text-caption leading-normal text-ink-muted">
					{trimmed}
				</pre>
			) : null}
		</div>
	);
}
