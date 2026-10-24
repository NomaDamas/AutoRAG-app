/**
 * A rename that would convert the file: the name typed into the row, the two
 * formats, and whether the conversion is already running (the dialog then shows
 * progress instead of the keep/replace choice).
 */
export interface ConvertRenameState {
	/** The handle `conversion.cancel` takes. */
	readonly id: string;
	/** The file being renamed; it is never modified, and moves to the Trash only when the user chose to replace it. */
	readonly path: string;
	/** Its current name. */
	readonly name: string;
	/** The name the user typed; the converted file takes it. */
	readonly newName: string;
	/** Extensions as typed, lower-case without the dot. */
	readonly from: string;
	readonly to: string;
	readonly working: boolean;
}
