import type { ReactElement } from "react";
import type { ModelDownloadStatus } from "../../../shared/model-download-contract";
import type { Translate } from "../onboarding/flow";
import { formatSize } from "../onboarding/flow";
import { downloadPercent } from "../state/model-download";
import { ProgressBar } from "./primitives/ProgressBar";

interface ModelDownloadPanelProps {
	readonly status: ModelDownloadStatus;
	readonly t: Translate;
	readonly onStart: () => void;
	readonly onCancel: () => void;
}

/**
 * The on-device embedding model's download, as one block for every place that needs it (the onboarding embedding
 * step and indexing screen, Settings). It reads the shared status and offers exactly the action that fits:
 * download or resume when nothing runs, cancel while it runs, retry after a failure, nothing once it is here.
 */
export function ModelDownloadPanel({ status, t, onStart, onCancel }: ModelDownloadPanelProps): ReactElement {
	const percent = downloadPercent(status);
	const size = formatSize(status.bytesTotal);
	if (status.state === "ready") {
		return (
			<div className="model-dl" data-state="ready" role="status">
				<span className="model-dl-title">{t("modelDownload.ready")}</span>
				<span className="model-dl-meta">{t("modelDownload.readyDetail")}</span>
			</div>
		);
	}
	const partial = status.state === "absent" && status.bytesDone > 0;
	return (
		<div className="model-dl" data-state={status.state}>
			<div className="model-dl-head">
				<span className="model-dl-title">{status.state === "failed" ? t("modelDownload.failed") : t("modelDownload.title")}</span>
				{status.state === "downloading" ? <span className="model-dl-meta">{t("modelDownload.percent", { percent })}</span> : null}
			</div>
			{status.state === "downloading" ? (
				<>
					<ProgressBar percent={percent} tone="run" label={t("modelDownload.progressAria")} />
					<span className="model-dl-meta">
						{t("modelDownload.amount", { done: formatSize(status.bytesDone), total: size })}
						{status.file === null ? "" : ` · ${t("modelDownload.file", { file: status.file })}`}
					</span>
					<span className="model-dl-meta">{t("modelDownload.keepOpen")}</span>
				</>
			) : status.state === "failed" ? (
				<span className="model-dl-error" role="alert">
					{status.error}
				</span>
			) : (
				<span className="model-dl-meta">{partial ? t("modelDownload.partial", { done: formatSize(status.bytesDone) }) : t("modelDownload.needed", { size })}</span>
			)}
			<div className="model-dl-actions">
				{status.state === "downloading" ? (
					<button type="button" onClick={onCancel}>
						{t("modelDownload.cancel")}
					</button>
				) : (
					<button type="button" className="primary" onClick={onStart}>
						{status.state === "failed" ? t("modelDownload.retry") : partial ? t("modelDownload.resume") : t("modelDownload.download")}
					</button>
				)}
			</div>
		</div>
	);
}
