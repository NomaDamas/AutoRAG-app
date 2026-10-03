import { parseFile } from "music-metadata";
import type { AudioMetadata } from "../shared/contract";

/** Cover art larger than this is skipped: the panel shows it at 212px. */
const PICTURE_CAP = 4 * 1024 * 1024;

/**
 * Tags, cover art, and stream facts of an audio file. Duration comes from the
 * headers only (no full scan), and the player's own clock replaces it once
 * the media has loaded.
 */
export async function readAudioMetadata(path: string): Promise<AudioMetadata> {
	const { common, format } = await parseFile(path, { duration: false, skipPostHeaders: true });
	const picture = common.picture?.find((item) => item.data.byteLength <= PICTURE_CAP) ?? null;
	return {
		title: common.title ?? null,
		artist: common.artist ?? null,
		album: common.album ?? null,
		duration: format.duration ?? null,
		bitrate: format.bitrate ?? null,
		sampleRate: format.sampleRate ?? null,
		codec: format.codec ?? format.container ?? null,
		picture: picture === null ? null : { mime: picture.format, data: new Uint8Array(picture.data) },
	};
}
