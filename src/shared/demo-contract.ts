/**
 * The practice material the tutorials hand a person: a sample photo, and one
 * example Magic Action that peeks into the text files it is run on. The automation example is not made here: the
 * person asks the AI for it in AI Search (that is the point of the lesson), and the tutorial only watches for the rule
 * to appear, then for the sample photo to be renamed once it is dropped in Downloads.
 */

export const DEMO_CHANNELS = {
	/** Put the sample photo (under a placeholder name) in the practice folder and report where everything is. */
	preparePhoto: "demo:preparePhoto",
	/** Make sure the background service that runs automations is up; resolves with whether it is. */
	ensureDaemon: "demo:ensureDaemon",
	/** Add the example Magic Action (and make sure its sample file exists). */
	prepareMagicAction: "demo:prepareMagicAction",
} as const;

/** The Magic Action the right-click tutorial creates. */
export const DEMO_MAGIC_ACTION_ID = "dazzi-demo-glance";

export interface DemoPhotoReady {
	/** `~/Dazzi 체험/연습 사진` (localized): the folder the person drags the photo out of. */
	readonly folder: string;
	/** The sample photo, with a placeholder name like `IMG_0001.jpg`. */
	readonly photo: string;
	/** The folder the AI-made rule is told to watch. */
	readonly downloads: string;
	/** Where the rule is asked to save the black-and-white copies: a sub-folder of `downloads` (the rule must not watch it). */
	readonly gray: string;
}

export interface DemoMagicActionReady {
	readonly root: string;
	/** A sample file to right-click. */
	readonly sample: string;
}

export interface DemoBridge {
	preparePhoto(): Promise<DemoPhotoReady>;
	ensureDaemon(): Promise<boolean>;
	prepareMagicAction(): Promise<DemoMagicActionReady>;
}
