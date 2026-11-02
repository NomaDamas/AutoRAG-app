/**
 * When a run takes the local track: Jev routed the question to the `local` branch, or the run has no Jev route and
 * went on to search the person's index anyway. The librarian does not announce this in its stream (`progress` carries
 * only the model's own notes, and the routing diagnostic arrives with the answer), so it is read from the progress
 * tracker the librarian keeps for its own terminal widget: the step the route ends in, and the steps only the local
 * branch runs. The tracker is a private field of the agent, reached by name; when a librarian release renames it the
 * warning goes quiet (the search itself is untouched), and the real-agent test in
 * `test/interactive-search-agent.test.ts` fails first.
 */

/** The slice of one tracker step this reads (`SearchProgressStep` in the librarian). */
interface TrackerStep {
	readonly id: string;
	readonly status: string;
	/** For the route step, the branch Jev chose. */
	readonly detail?: string;
}

interface TrackerSnapshot {
	readonly active: boolean;
	readonly steps: readonly TrackerStep[];
}

interface ProgressTracker {
	subscribe(listener: (snapshot: TrackerSnapshot) => void): () => void;
}

/** Steps only the local branch runs: choosing datasources, the index searches, the datasource searches, the first answer. */
const LOCAL_ONLY_STEPS: Readonly<Record<string, true>> = { "datasource-select": true, minsync: true, jikji: true, fast: true };

/** True once the snapshot shows the run searching (or about to search) the person's index. */
export function enteredLocalTrack(snapshot: Pick<TrackerSnapshot, "steps">): boolean {
	return snapshot.steps.some(
		(step) => (step.id === "route" && step.status === "done" && step.detail === "local") || LOCAL_ONLY_STEPS[step.id] === true || step.id.startsWith("datasource:"),
	);
}

function trackerOf(agent: object): ProgressTracker | null {
	const tracker: unknown = Reflect.get(agent, "searchProgress");
	return typeof tracker === "object" && tracker !== null && typeof Reflect.get(tracker, "subscribe") === "function" ? (tracker as ProgressTracker) : null;
}

let warned = false;

/**
 * Calls `listener` once per run, the moment the run takes the local track. Returns the stop function. An agent with
 * no readable tracker is never called back.
 */
export function watchLocalTrack(agent: object, listener: () => void): () => void {
	const tracker = trackerOf(agent);
	if (tracker === null) {
		if (!warned) {
			warned = true;
			console.warn("[search] the librarian agent keeps no progress tracker: the index notice is off.");
		}
		return () => undefined;
	}
	let called = false;
	return tracker.subscribe((snapshot) => {
		// A run begins with no steps and ends inactive: both re-arm the callback for the next run.
		if (!snapshot.active || snapshot.steps.length === 0) {
			called = false;
			return;
		}
		if (called || !enteredLocalTrack(snapshot)) return;
		called = true;
		listener();
	});
}
