import { useEffect, useState, type ReactElement } from "react";
import type { AccessRequest } from "../../../shared/settings-contract";
import type { SettingsBridge } from "../../../shared/settings-contract";
import { cn } from "../lib/cn";
import { CloseIcon } from "./icons";
import { FileTile } from "./primitives/FileTile";
import { iconButtonClass } from "./primitives/icon-button";

const settings = (window as unknown as { readonly autorag: { readonly settings: SettingsBridge } }).autorag.settings;
const fs = (window as unknown as { readonly autorag: { readonly fs: { reveal(path: string): Promise<void> } } }).autorag.fs;

export function RequestsPopover({ onClose, onChanged }: { readonly onClose: () => void; readonly onChanged?: () => void }): ReactElement {
	const [tab, setTab] = useState<"pending" | "done">("pending");
	const [requests, setRequests] = useState<readonly AccessRequest[]>([]);

	useEffect(() => {
		void settings.requestsList(tab).then(setRequests);
	}, [tab]);

	async function respond(id: string, allow: boolean): Promise<void> {
		await settings.requestsRespond(id, allow);
		setRequests((current) => current.filter((request) => request.id !== id));
		onChanged?.();
	}

	return (
		<>
			<button className="requests-popover__scrim fixed inset-0 z-[29] border-0 bg-transparent" type="button" aria-label="Close Requests" onClick={onClose} />
			<section className="requests-popover fixed left-[220px] bottom-12 z-[30] flex flex-col w-[min(420px,calc(100%_-_24px))] max-h-[calc(100%_-_24px)] border border-border rounded-12 bg-window shadow-window overflow-hidden" role="dialog" aria-modal="true" aria-label="Requests">
				<header className="requests-popover__header flex items-center gap-10 h-[52px] flex-none py-0 pr-10 pl-16 border-b border-border">
					<strong>Requests</strong>
					<nav className="requests-popover__tabs flex gap-2 p-3 rounded-8 bg-input" aria-label="Request status">
						<button type="button" className={cn("h-24 py-0 px-10 border-0 rounded-6 text-meta", tab === "pending" ? "is-active bg-window text-ink" : "bg-transparent text-ink-muted")} onClick={() => setTab("pending")}>대기 중 {tab === "pending" ? requests.length : ""}</button>
						<button type="button" className={cn("h-24 py-0 px-10 border-0 rounded-6 text-meta", tab === "done" ? "is-active bg-window text-ink" : "bg-transparent text-ink-muted")} onClick={() => setTab("done")}>처리됨</button>
					</nav>
					<button type="button" className={cn("icon-button ml-auto", iconButtonClass())} aria-label="Close Requests" title="Close" onClick={onClose}><CloseIcon /></button>
				</header>
				<div className="requests-popover__body flex flex-col gap-8 p-12 overflow-auto">
					{requests.length === 0 ? (
						<div className="requests-popover__empty flex flex-col gap-6 py-[28px] px-12 text-ink-muted text-center">
							<strong>{tab === "pending" ? "대기 중인 요청이 없습니다" : "처리된 요청이 없습니다"}</strong>
							<span>{tab === "pending" ? "새로운 접근 요청이 여기에 표시됩니다." : "처리된 요청이 여기에 표시됩니다."}</span>
						</div>
					) : requests.map((request) => (
						<article className="request-card flex flex-col gap-8 p-12 border border-border rounded-10 bg-window" key={request.id}>
							<div className="request-card__topline flex items-center gap-8">
								<div className="request-card__avatar flex items-center justify-center size-icon-sm rounded-full bg-accent-soft text-accent-text font-semibold">{request.contactName.slice(0, 1).toUpperCase()}</div>
								<div className="request-card__identity flex flex-col gap-2 min-w-0">
									<strong>{request.contactName}</strong>
									<span className="m-0 text-ink-muted text-meta">{request.contactRole} · {request.requestedAt}</span>
								</div>
							</div>
							<p className="m-0 text-ink-muted text-meta">{request.question}</p>
							<div className="request-card__files flex items-center gap-8 flex-wrap">
								{request.files.map((file) => (
									<div className="request-card__file inline-flex items-center gap-5 py-4 px-[7px] border border-border rounded-6 text-ink-body text-meta" key={file.path}>
										<FileTile kind="pdf" size={16} />
										<div className="flex flex-col gap-1 min-w-0"><strong>{file.name}</strong><small className="overflow-hidden max-w-[280px] text-ink-muted text-badge text-ellipsis whitespace-nowrap">{file.path}</small></div>
									</div>
								))}
							</div>
							<button type="button" className="request-card__reveal self-start p-0 border-0 bg-transparent text-ink-body text-meta hover:text-accent-text" onClick={() => void Promise.all(request.files.map((file) => fs.reveal(file.path)))}>Show in Finder</button>
							{request.status === "pending" ? (
								<div className="request-card__actions flex items-center gap-8 justify-end">
									<button type="button" className="request-card__deny h-[30px] py-0 px-10 border border-border rounded-6 bg-window" onClick={() => void respond(request.id, false)}>거부</button>
									<button type="button" className="request-card__allow h-[30px] py-0 px-10 border border-accent rounded-6 bg-accent text-on-badge" onClick={() => void respond(request.id, true)}>허용</button>
								</div>
							) : <span className={cn(`request-card__status request-card__status--${request.status}`, request.status === "allowed" ? "text-info-text" : "text-danger-text")}>{request.status === "allowed" ? "Allowed" : "Denied"}</span>}
						</article>
					))}
				</div>
			</section>
		</>
	);
}
