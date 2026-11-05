/**
 * The practice material the tutorials hand a person: a folder with sample files, one example automation that
 * sorts what lands in its inbox, and one example Magic Action that summarises the files it is run on. They are
 * real rules and real actions (the person can open, edit, and delete them like their own); the tutorials only
 * create them so that "what is this for" is answered by watching one run.
 */

export const DEMO_CHANNELS = {
	/** Create the practice folder and the example automation (and start its daemon); resolves when it is ready to be triggered. */
	prepareAutomation: "demo:prepareAutomation",
	/** Drop a sample file in the automation's inbox so the rule has something to do. */
	triggerAutomation: "demo:triggerAutomation",
	/** Add the example Magic Action (and make sure its sample file exists). */
	prepareMagicAction: "demo:prepareMagicAction",
} as const;

/** The rule the automation tutorial creates. */
export const DEMO_AUTOMATION_ID = "dazzi-demo-sort";
/** The Magic Action the right-click tutorial creates. */
export const DEMO_MAGIC_ACTION_ID = "dazzi-demo-glance";

export interface DemoAutomationReady {
	/** `~/Dazzi 체험` (localised), where everything below lives. */
	readonly root: string;
	/** Files dropped here are sorted by the rule. */
	readonly inbox: string;
	/** The rule is in the rules file and its daemon is installed; false when the daemon could not be started. */
	readonly daemon: boolean;
}

export interface DemoTrigger {
	/** The sample file that was dropped in the inbox. */
	readonly dropped: string;
	/** Where the rule is expected to move it (a folder under the practice root). */
	readonly destination: string;
}

export interface DemoMagicActionReady {
	readonly root: string;
	/** A sample file to right-click. */
	readonly sample: string;
}

export interface DemoBridge {
	prepareAutomation(): Promise<DemoAutomationReady>;
	triggerAutomation(): Promise<DemoTrigger>;
	prepareMagicAction(): Promise<DemoMagicActionReady>;
}
