import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import { useChrome, useHiddenTitle, usePanelHeight } from "./chrome";
import { FileGlyph, LockIcon } from "./icons";

const PASSWORD_WIDTH = 520;

/**
 * The panel for a file that needs a password before it can be shown (an
 * encrypted PDF). `incorrect` says the last password was refused; `onSubmit`
 * hands the typed one to the viewer. The field owns Space and the arrows while
 * it has focus: the window is told so through `bridge.textEntry`.
 */
export function PasswordView({
	file,
	incorrect,
	onSubmit,
}: {
	readonly file: PreviewDocument;
	readonly incorrect: boolean;
	readonly onSubmit: (password: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const { bridge } = useChrome();
	useHiddenTitle();
	const attach = usePanelHeight(PASSWORD_WIDTH);
	const field = useRef<HTMLInputElement>(null);
	const [password, setPassword] = useState("");
	const [checking, setChecking] = useState(false);
	const label = file.ext === "" ? "FILE" : file.ext.slice(0, 4).toUpperCase();

	useEffect(() => {
		bridge.textEntry(true);
		return () => bridge.textEntry(false);
	}, [bridge]);

	useEffect(() => {
		field.current?.focus();
	}, []);

	function submit(event: { preventDefault(): void }): void {
		event.preventDefault();
		if (password === "" || checking) return;
		setChecking(true);
		onSubmit(password);
	}

	return (
		<form ref={attach} className="ql-password flex items-center gap-28 w-full p-32 box-border" onSubmit={submit}>
			<FileGlyph label={label} scale={0.6} />
			<div className="flex flex-col flex-1 gap-6 min-w-0">
				<div className="flex items-center gap-6 text-[13px] text-ql-ink-secondary">
					<LockIcon />
					<span>{t("quickLook.password.locked")}</span>
				</div>
				<div className="mb-4 overflow-hidden text-[18px] font-bold tracking-[-0.01em] text-ellipsis whitespace-nowrap select-text" title={file.name}>
					{file.name}
				</div>
				<div className="flex gap-8">
					<input
						ref={field}
						type="password"
						value={password}
						disabled={checking}
						onChange={(event) => setPassword(event.target.value)}
						placeholder={t("quickLook.password.placeholder")}
						aria-label={t("quickLook.password.label")}
						aria-invalid={incorrect}
						autoComplete="off"
						spellCheck={false}
						className="flex-1 min-w-0 h-28 px-10 border border-ql-hairline rounded-6 bg-ql-code text-ql-ink font-ql text-[13px] outline-none focus:border-ql-accent"
					/>
					<button
						type="submit"
						disabled={password === "" || checking}
						className="flex-none h-28 px-14 border-0 rounded-6 bg-ql-accent text-white font-ql text-[13px] font-medium cursor-default disabled:opacity-40"
					>
						{t("quickLook.password.unlock")}
					</button>
				</div>
				<div className="min-h-16 text-[12px] text-ql-syntax-string" role={incorrect ? "alert" : undefined}>
					{incorrect ? t("quickLook.password.incorrect") : checking ? <span className="text-ql-ink-secondary">{t("quickLook.password.checking")}</span> : null}
				</div>
			</div>
		</form>
	);
}
