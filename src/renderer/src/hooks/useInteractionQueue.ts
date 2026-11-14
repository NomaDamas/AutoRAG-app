import { useEffect, useState } from "react";
import { closeRequest, EMPTY_QUEUE, mergePending, openRequest, type InteractionQueue } from "../state/interaction";

/**
 * The agent's open requests (`ask_user` questions and file-change approvals), oldest first, across every search the
 * window hosts. `pending()` covers a request that opened before the caller subscribed (a tab switch or reload); the
 * stream keeps it current. Each surface shows the head of its own run's requests with `frontRequest`.
 */
export function useInteractionQueue(): InteractionQueue {
	const [queue, setQueue] = useState<InteractionQueue>(EMPTY_QUEUE);
	useEffect(() => {
		const bridge = window.autorag?.interaction;
		if (bridge === undefined) return;
		let alive = true;
		void bridge.pending().then((requests) => {
			if (alive) setQueue((current) => mergePending(current, requests));
		});
		const offRequest = bridge.onRequest((request) => setQueue((current) => openRequest(current, request)));
		const offClosed = bridge.onClosed((event) => setQueue((current) => closeRequest(current, event.id)));
		return () => {
			alive = false;
			offRequest();
			offClosed();
		};
	}, []);
	return queue;
}
