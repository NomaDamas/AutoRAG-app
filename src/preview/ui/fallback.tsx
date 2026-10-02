import type { ReactElement } from "react";
import type { PreviewDocument } from "../shared/contract";
import { formatBytes, formatModified } from "../shared/format";
import { describeExtension } from "../shared/registry";

export function FallbackView({ file, note }: { readonly file: PreviewDocument; readonly note?: string }): ReactElement {
	const label = file.ext === "" ? "FILE" : file.ext.slice(0, 4).toUpperCase();
	return (
		<div className="ql__fallback grid gap-8 justify-items-center p-24 text-center">
			<div className="ql__glyph grid w-[88px] h-[108px] place-items-center border border-border rounded-12 bg-window shadow-raised text-ink-muted text-sm font-bold tracking-label">
				{label}
			</div>
			<p className="ql__name m-0 text-sm font-semibold">{describeExtension(file.ext)}</p>
			<p className="ql__meta m-0 text-ink-muted text-badge">
				{formatBytes(file.size)} · {formatModified(file.modifiedAt)}
			</p>
			{note === undefined ? null : <p className="ql__note m-0 text-ink-muted text-sm">{note}</p>}
		</div>
	);
}

export function Status({ children }: { readonly children: string }): ReactElement {
	return <p className="ql__status m-0 text-ink-muted text-sm">{children}</p>;
}
