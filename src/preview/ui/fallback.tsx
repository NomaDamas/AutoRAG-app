import type { ReactElement } from "react";
import type { PreviewDocument } from "../shared/contract";
import { formatBytes, formatModified } from "../shared/format";
import { describeExtension } from "../shared/registry";

export function FallbackView({ file, note }: { readonly file: PreviewDocument; readonly note?: string }): ReactElement {
	const label = file.ext === "" ? "FILE" : file.ext.slice(0, 4).toUpperCase();
	return (
		<div className="ql__fallback">
			<div className="ql__glyph">{label}</div>
			<p className="ql__name">{describeExtension(file.ext)}</p>
			<p className="ql__meta">
				{formatBytes(file.size)} · {formatModified(file.modifiedAt)}
			</p>
			{note === undefined ? null : <p className="ql__note">{note}</p>}
		</div>
	);
}

export function Status({ children }: { readonly children: string }): ReactElement {
	return <p className="ql__status">{children}</p>;
}
