import type { ReactElement } from "react";
import type { ModelDownloadStatus } from "../../../shared/model-download-contract";
import { downloadPercent } from "../state/model-download";
import { ProgressBar } from "./primitives/ProgressBar";

/** A loose `t`: the panel's keys are fixed, and a loose signature keeps callers free of i18next's key typing. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "1.2 GB" / "812 MB": decimal units, as model hosts publish download sizes. */
export function formatDownloadSize(bytes: number): string {
	if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
	if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
	// Anything above zero shows as at least 1 KB, so a partial download is never reported as empty.
	return `${bytes <= 0 ? 0 : Math.max(1, Math.round(bytes / 1000))} KB`;
}

interface ModelDownloadPanelProps {
	readonly status: ModelDownloadStatus;
	readonly t: Translate;
	readonly onStart: () => void;
	readonly onCancel: () => void;
}

/**
 * The on-device embedding model's download, as one block for every place that needs it (Settings → embedding).
 * It reads the shared status and offers exactly the action that fits:
 * download or resume when nothing runs, cancel while it runs, retry after a failure, nothing once it is here.
 */
export function ModelDownloadPanel({ status, t, onStart, onCancel }: ModelDownloadPanelProps): ReactElement {
	const percent = downloadPercent(status);
	const size = formatDownloadSize(status.bytesTotal);
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
						{t("modelDownload.amount", { done: formatDownloadSize(status.bytesDone), total: size })}
						{status.file === null ? "" : ` · ${t("modelDownload.file", { file: status.file })}`}
					</span>
					<span className="model-dl-meta">{t("modelDownload.keepOpen")}</span>
				</>
			) : status.state === "failed" ? (
				<span className="model-dl-error" role="alert">
					{status.error}
				</span>
			) : (
				<span className="model-dl-meta">{partial ? t("modelDownload.partial", { done: formatDownloadSize(status.bytesDone) }) : t("modelDownload.needed", { size })}</span>
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
