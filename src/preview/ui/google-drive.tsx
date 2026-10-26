import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import { readGoogleDrivePointer } from "../shared/google-drive";
import { FallbackView } from "./fallback";

/**
 * A Google Drive pointer (`.gdoc`, `.gsheet`, `.gslides`, `.gform`, ...): the
 * document itself lives in Google's cloud, so the panel shows the thumbnail
 * Drive for desktop's file provider drew for the OS, with the name, kind and
 * the account that owns it. The toolbar's Open button hands the pointer to
 * Drive, which opens the real document in the browser.
 */
export function GoogleDriveView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const pointer = useMemo(() => (file.bytes === null ? null : readGoogleDrivePointer(file.bytes)), [file.bytes]);
	const note = pointer === null ? t("quickLook.gdrive.notPointer") : pointer.email === null ? undefined : t("quickLook.gdrive.account", { email: pointer.email });
	const art =
		file.thumbnail === null ? undefined : (
			<img
				className="ql-gdrive__thumbnail flex-none size-176 object-cover rounded-6 bg-white [filter:drop-shadow(0_3px_6px_rgba(0,0,0,0.18))]"
				alt=""
				draggable={false}
				src={file.thumbnail}
			/>
		);
	return <FallbackView file={file} note={note} art={art} />;
}
