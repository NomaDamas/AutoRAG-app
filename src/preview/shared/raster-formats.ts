/**
 * Picture formats a browser cannot decode and the Finder's thumbnailer may not
 * draw: camera RAW, Photoshop, EPS, Apple icons, TGA, OpenEXR, and the design
 * tools' packages. Each one is shown as an image the main process produces
 * (the file's own embedded preview, or what macOS decodes), never as raw bytes.
 */

/** Camera RAW containers; `raw` is the Panasonic/Leica spelling, sniffed by content. */
export const RAW_PHOTO_EXTENSIONS: readonly string[] = ["cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raw"];

/** Every extension the raster viewer owns. */
export const RASTER_EXTENSIONS: readonly string[] = [...RAW_PHOTO_EXTENSIONS, "psd", "eps", "icns", "tga", "exr", "sketch", "fig"];
