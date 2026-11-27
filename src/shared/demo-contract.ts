/**
 * The practice material the tutorials hand a person: a sample photo, and a sample text file to right-click. The
 * automation itself is not made here: the person adds it from the recommendations (that is the point of the lesson).
 */

export const DEMO_CHANNELS = {
	/** Put the sample photo (under a placeholder name) in the practice folder and report where everything is. */
	preparePhoto: "demo:preparePhoto",
	/** Make sure the background service that runs automations is up; resolves with whether it is. */
	ensureDaemon: "demo:ensureDaemon",
	/** Make sure the sample text file exists, and add nothing: the automations tutorial has the person make the action. */
	prepareSample: "demo:prepareSample",
} as const;

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
	prepareSample(): Promise<DemoMagicActionReady>;
}
