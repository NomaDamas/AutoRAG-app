import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs` while `active`, so "3 min ago" keeps counting between pushes. */
export function useNow(active: boolean, intervalMs = 1_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [active, intervalMs]);
	return now;
}
