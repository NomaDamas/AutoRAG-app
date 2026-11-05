/**
 * The index map's canvas: the scope as a planet (`globe.ts`), drawn as a lit
 * orthographic globe in an election-night studio. On open the count rolls in:
 * every indexed region starts red and turns blue in turn, and `onProgress`
 * reports how far the count is so the scoreboard ticks along with the globe.
 * Drag turns the globe, the wheel zooms, hovering names the region under the
 * pointer; left alone it sways slowly around the scope.
 *
 * Imperative on purpose: the globe is shaded per pixel every frame, which
 * React state would only slow down. The modal owns one scene per map and
 * disposes it on close.
 */

import type { IndexMap, IndexMapNode } from "../../../../../shared/index-map-contract";
import { cellAt, dot, GLOBE_COLORS, hash, layoutGlobe, OCEAN, paintGlobe, stateAt, type GlobeSite, type Rgb, type Vec3 } from "./globe";

export interface SceneHover {
	readonly node: IndexMapNode;
	/** CSS pixels inside the canvas. */
	readonly x: number;
	readonly y: number;
}

export interface IndexMapScene {
	/** Turn back to the scope and frame the whole globe. */
	fit(): void;
	dispose(): void;
}

export interface IndexMapSceneOptions {
	readonly reducedMotion: boolean;
	/** Play the opening count; false shows the final map at once (a reload while the map is open). */
	readonly reveal: boolean;
	readonly onHover: (hover: SceneHover | null) => void;
	/** How far the opening count is, 0..1; called each frame while it runs and once with 1. */
	readonly onProgress?: (progress: number) => void;
}

/** Shaded pixels per frame; above it the globe is shaded at a lower resolution and scaled up. */
const PIXEL_BUDGET = 360_000;
const COUNT_MS = 3200;
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 3;
const MAX_PITCH = 1.25;
/** Light from the upper left, a little in front. */
const LIGHT: Vec3 = (() => {
	const [x, y, z] = [-0.5, 0.55, 0.68];
	const length = Math.hypot(x, y, z);
	return [x / length, y / length, z / length];
})();
/** Half-vector for the ocean's specular glint (viewer on +z). */
const HALF: Vec3 = (() => {
	const [x, y, z] = [LIGHT[0], LIGHT[1], LIGHT[2] + 1];
	const length = Math.hypot(x, y, z);
	return [x / length, y / length, z / length];
})();

function rgba([r, g, b]: Rgb, alpha: number): string {
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Slow start and finish, so the red map is seen before blue sweeps it and the last calls land one by one. */
function easeInOut(t: number): number {
	return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

function latLonOf([x, y, z]: Vec3): { lat: number; lon: number } {
	return { lat: Math.asin(Math.max(-1, Math.min(1, y))), lon: Math.atan2(x, z) };
}

export function createIndexMapScene(canvas: HTMLCanvasElement, map: IndexMap, options: IndexMapSceneOptions): IndexMapScene {
	const context = canvas.getContext("2d");
	const sites = layoutGlobe(map);
	const texture = paintGlobe(sites);
	const leaves = sites.filter((site) => site.leaf && site.reach > 0);
	/** Folders and roots get a pin; deeper ones only once zoomed in. */
	const pins = sites.filter((site) => site.node.kind === "root" || site.node.kind === "folder").sort((a, b) => a.node.depth - b.node.depth || b.node.weight - a.node.weight);
	const home = latLonOf(sites.find((site) => site.node.parent === null)?.at ?? [0, 0, 1]);
	const homeView = { yaw: home.lon, pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, home.lat)) };

	let width = 0;
	let height = 0;
	let dpr = 1;
	const view = { yaw: homeView.yaw, pitch: homeView.pitch, k: 1 };
	/** Left alone, the globe sways around the scope; a drag hands it to the person until `fit`. */
	let swaying = !options.reducedMotion;
	let swayStart = performance.now();
	let spin = { yaw: 0, pitch: 0 };
	let hovered: GlobeSite | null = null;
	let frame = 0;
	let disposed = false;
	const countStart = performance.now();
	let progress = options.reveal && !options.reducedMotion ? 0 : 1;
	const buffer = document.createElement("canvas");
	const bufferContext = buffer.getContext("2d");
	let image: ImageData | null = null;
	const studioLights = Array.from({ length: 90 }, (_, index) => ({ x: hash(index * 3 + 1), y: hash(index * 3 + 2), size: 0.4 + hash(index * 3 + 3) * 1.1 }));

	/** World → view rotation, rows; its transpose takes a view vector back to the world. */
	function rotation(): number[] {
		const cy = Math.cos(view.yaw);
		const sy = Math.sin(view.yaw);
		const cp = Math.cos(view.pitch);
		const sp = Math.sin(view.pitch);
		// Yaw about +y, then pitch about +x.
		return [cy, 0, -sy, -sp * sy, cp, -sp * cy, cp * sy, sp, cp * cy];
	}

	function radius(): number {
		return Math.min(width, height) * 0.4 * view.k;
	}

	function toView(m: number[], [x, y, z]: Vec3): Vec3 {
		return [m[0]! * x + m[1]! * y + m[2]! * z, m[3]! * x + m[4]! * y + m[5]! * z, m[6]! * x + m[7]! * y + m[8]! * z];
	}

	function toScreen(m: number[], at: Vec3): { x: number; y: number; z: number } {
		const [vx, vy, vz] = toView(m, at);
		const r = radius();
		return { x: width / 2 + vx * r, y: height / 2 - vy * r, z: vz };
	}

	/** The world point under a screen point, or null off the globe. */
	function fromScreen(m: number[], sx: number, sy: number): Vec3 | null {
		const r = radius();
		const u = (sx - width / 2) / r;
		const v = -(sy - height / 2) / r;
		const rest = 1 - u * u - v * v;
		if (rest < 0) return null;
		const w = Math.sqrt(rest);
		return [m[0]! * u + m[3]! * v + m[6]! * w, m[1]! * u + m[4]! * v + m[7]! * w, m[2]! * u + m[5]! * v + m[8]! * w];
	}

	function resize(): void {
		const rect = canvas.getBoundingClientRect();
		dpr = window.devicePixelRatio || 1;
		width = Math.max(1, rect.width);
		height = Math.max(1, rect.height);
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		schedule();
	}

	function drawStudio(ctx: CanvasRenderingContext2D): void {
		const floor = ctx.createRadialGradient(width * 0.5, height * 0.5, 0, width * 0.5, height * 0.5, Math.max(width, height) * 0.72);
		floor.addColorStop(0, "#101b38");
		floor.addColorStop(0.6, "#070d1f");
		floor.addColorStop(1, "#03060e");
		ctx.fillStyle = floor;
		ctx.fillRect(0, 0, width, height);
		// Broadcast grid: faint lines behind the globe.
		ctx.strokeStyle = "rgba(90, 120, 190, 0.07)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let x = (width / 2) % 48; x < width; x += 48) {
			ctx.moveTo(x, 0);
			ctx.lineTo(x, height);
		}
		for (let y = (height / 2) % 48; y < height; y += 48) {
			ctx.moveTo(0, y);
			ctx.lineTo(width, y);
		}
		ctx.stroke();
		for (const light of studioLights) {
			ctx.fillStyle = `rgba(200, 215, 255, ${0.12 + light.size * 0.12})`;
			ctx.beginPath();
			ctx.arc(light.x * width, light.y * height, light.size, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	function drawAtmosphere(ctx: CanvasRenderingContext2D): void {
		const r = radius();
		const glow = ctx.createRadialGradient(width / 2, height / 2, r * 0.96, width / 2, height / 2, r * 1.18);
		glow.addColorStop(0, "rgba(70, 120, 200, 0.42)");
		glow.addColorStop(0.35, "rgba(40, 80, 160, 0.16)");
		glow.addColorStop(1, "rgba(20, 40, 90, 0)");
		ctx.fillStyle = glow;
		ctx.beginPath();
		ctx.arc(width / 2, height / 2, r * 1.18, 0, Math.PI * 2);
		ctx.fill();
	}

	/** Shades every globe pixel: land lit by the sun and raised by its density, sea with a glint, a graticule, a blue rim. */
	function drawGlobe(ctx: CanvasRenderingContext2D, m: number[]): void {
		if (bufferContext === null) return;
		const r = radius();
		const left = Math.max(0, Math.floor(width / 2 - r));
		const top = Math.max(0, Math.floor(height / 2 - r));
		const right = Math.min(width, Math.ceil(width / 2 + r));
		const bottom = Math.min(height, Math.ceil(height / 2 + r));
		if (right <= left || bottom <= top) return;
		const scale = Math.min(dpr, Math.sqrt(PIXEL_BUDGET / ((right - left) * (bottom - top))));
		const bw = Math.max(1, Math.round((right - left) * scale));
		const bh = Math.max(1, Math.round((bottom - top) * scale));
		if (image === null || image.width !== bw || image.height !== bh) {
			buffer.width = bw;
			buffer.height = bh;
			image = bufferContext.createImageData(bw, bh);
		}
		const data = image.data;
		data.fill(0);
		const { width: tw, height: th, edge, elevation, flipAt } = texture;
		const flash = 0.05;
		// Graticule line width as a share of a 15° band: about one screen pixel at any zoom.
		const line = Math.min(0.03, 1.2 / Math.max(1, r * (Math.PI / 12)));
		for (let py = 0; py < bh; py += 1) {
			const v = -((top + (py + 0.5) / scale) - height / 2) / r;
			for (let px = 0; px < bw; px += 1) {
				const u = ((left + (px + 0.5) / scale) - width / 2) / r;
				const rest = 1 - u * u - v * v;
				if (rest <= 0) continue;
				const w = Math.sqrt(rest);
				const wx = m[0]! * u + m[3]! * v + m[6]! * w;
				const wy = m[1]! * u + m[4]! * v + m[7]! * w;
				const wz = m[2]! * u + m[5]! * v + m[8]! * w;
				const lat = Math.asin(wy < -1 ? -1 : wy > 1 ? 1 : wy);
				const lon = Math.atan2(wx, wz);
				const column = Math.min(tw - 1, Math.floor(((lon + Math.PI) / (2 * Math.PI)) * tw));
				const row = Math.min(th - 1, Math.floor(((Math.PI / 2 - lat) / Math.PI) * th));
				const cell = row * tw + column;
				const diffuse = Math.max(0, u * LIGHT[0] + v * LIGHT[1] + w * LIGHT[2]);
				const state = stateAt(texture, cell, progress);
				let red: number;
				let green: number;
				let blue: number;
				if (state === null || state === "excluded" || state === "unindexable") {
					const [sr, sg, sb] = state === null ? OCEAN : GLOBE_COLORS[state];
					const light = 0.45 + diffuse * 0.75;
					const glint = Math.max(0, u * HALF[0] + v * HALF[1] + w * HALF[2]) ** 60 * 0.6;
					// The graticule: faint lines every 15° over open water.
					const latLine = Math.abs(((lat * 12) / Math.PI) % 1);
					const lonLine = Math.abs(((lon * 12) / Math.PI) % 1);
					const grid = latLine < line || latLine > 1 - line || lonLine < line * 1.6 || lonLine > 1 - line * 1.6 ? 0.12 : 0;
					const shoreline = state !== null && (edge[cell] ?? 0) === 1 ? 0.18 : 0;
					red = sr * light + 255 * (glint + grid * 0.5 + shoreline * 0.4);
					green = sg * light + 255 * (glint + grid * 0.7 + shoreline * 0.5);
					blue = sb * light + 255 * (glint + grid + shoreline * 0.7);
				} else {
					const [lr, lg, lb] = GLOBE_COLORS[state];
					const lift = Math.min(0.22, (elevation[cell] ?? 0) * 0.045);
					const light = 0.42 + diffuse * 0.72;
					// A white line where one state meets another or the coast; a white flash where the count just turned the ground blue.
					const since = progress - (flipAt[cell] ?? 2);
					const white = ((edge[cell] ?? 0) === 1 ? 0.5 : 0) + (state === "indexed" && since >= 0 && since < flash ? (1 - since / flash) * 0.7 : 0) + lift;
					red = (lr + (255 - lr) * white) * light;
					green = (lg + (255 - lg) * white) * light;
					blue = (lb + (255 - lb) * white) * light;
				}
				// Rim light: the atmosphere brightens the limb.
				const rim = (1 - w) ** 3 * 0.55;
				const offset = (py * bw + px) * 4;
				data[offset] = red + 90 * rim;
				data[offset + 1] = green + 150 * rim;
				data[offset + 2] = blue + 255 * rim;
				// Anti-aliased edge of the disk.
				data[offset + 3] = Math.min(255, rest * r * 0.5 * scale * 255);
			}
		}
		bufferContext.putImageData(image, 0, 0);
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(buffer, left, top, bw / scale, bh / scale);
	}

	function drawPins(ctx: CanvasRenderingContext2D, m: number[]): void {
		const r = radius();
		const maxDepth = view.k < 1.4 ? 1 : view.k < 2.4 ? 2 : 3;
		const placed: { left: number; top: number; right: number; bottom: number }[] = [];
		ctx.textBaseline = "middle";
		for (const site of pins) {
			const { node } = site;
			if (node.depth > maxDepth) continue;
			const point = toScreen(m, site.at);
			if (point.z < 0.18) continue;
			const fade = Math.min(1, (point.z - 0.18) * 4);
			const root = node.kind === "root";
			const indexable = node.counts.indexed + node.counts.stale + node.counts.unindexed;
			// The callout ticks with the count, like the scoreboard: indexed files cross over from red as it runs.
			const share = indexable === 0 ? null : Math.round((Math.round(node.counts.indexed * progress) * 100) / indexable);
			const leading: Rgb = share === null ? GLOBE_COLORS.excluded : share >= 50 ? GLOBE_COLORS.indexed : GLOBE_COLORS.unindexed;
			const label = root ? (node.name.split(/[\\/]/u).filter(Boolean).at(-1) ?? node.name) : node.name;
			const text = share === null ? label : `${label}  ${share}%`;
			ctx.font = root ? "700 12px system-ui, -apple-system, sans-serif" : "600 10.5px system-ui, -apple-system, sans-serif";
			const textWidth = ctx.measureText(text).width;
			const boxHeight = root ? 22 : 18;
			const boxWidth = textWidth + 18;
			const lift = root ? 30 : 20;
			const box = { left: point.x - boxWidth / 2, top: point.y - lift - boxHeight, right: point.x + boxWidth / 2, bottom: point.y - lift };
			const crowded = placed.some((other) => box.left < other.right + 4 && box.right > other.left - 4 && box.top < other.bottom + 2 && box.bottom > other.top - 2);
			// The pin always shows; its callout only where it has room.
			ctx.globalAlpha = fade;
			ctx.fillStyle = "#ffffff";
			ctx.beginPath();
			ctx.arc(point.x, point.y, root ? 3.4 : 2.4, 0, Math.PI * 2);
			ctx.fill();
			ctx.strokeStyle = rgba(leading, 0.95);
			ctx.lineWidth = 1.6;
			ctx.stroke();
			if (!crowded && r > 60) {
				placed.push(box);
				ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(point.x, point.y - 4);
				ctx.lineTo(point.x, box.bottom);
				ctx.stroke();
				ctx.fillStyle = "rgba(6, 12, 28, 0.86)";
				ctx.beginPath();
				ctx.roundRect(box.left, box.top, boxWidth, boxHeight, 4);
				ctx.fill();
				// A bar on the left in the color of who is ahead, like a called race.
				ctx.fillStyle = rgba(leading, 1);
				ctx.fillRect(box.left, box.top, 4, boxHeight);
				ctx.fillStyle = "rgba(246, 248, 255, 0.98)";
				ctx.textAlign = "left";
				ctx.fillText(text, box.left + 11, box.top + boxHeight / 2 + 0.5);
			}
			if (site === hovered) {
				ctx.strokeStyle = "rgba(255, 244, 214, 0.95)";
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
				ctx.stroke();
			}
			ctx.globalAlpha = 1;
		}
		if (hovered !== null && hovered.leaf) {
			const point = toScreen(m, hovered.at);
			if (point.z > 0) {
				ctx.strokeStyle = "rgba(255, 244, 214, 0.95)";
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(point.x, point.y, Math.max(5, Math.sin(hovered.reach) * r * point.z * 0.7), 0, Math.PI * 2);
				ctx.stroke();
			}
		}
	}

	function draw(): void {
		if (context === null) return;
		const m = rotation();
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawStudio(context);
		drawAtmosphere(context);
		drawGlobe(context, m);
		drawPins(context, m);
	}

	let last = performance.now();
	function step(time: number): void {
		frame = 0;
		if (disposed) return;
		const dt = Math.min(0.05, (time - last) / 1000);
		last = time;
		if (progress < 1) {
			progress = Math.min(1, easeInOut(Math.max(0, time - countStart) / COUNT_MS));
			options.onProgress?.(progress);
		}
		if (swaying && drag === null) view.yaw = homeView.yaw + Math.sin(((time - swayStart) / 1000) * 0.22) * 0.38;
		if (drag === null && (Math.abs(spin.yaw) > 1e-4 || Math.abs(spin.pitch) > 1e-4)) {
			// Inertia after a flick.
			view.yaw += spin.yaw * dt * 60;
			view.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, view.pitch + spin.pitch * dt * 60));
			spin = { yaw: spin.yaw * 0.92, pitch: spin.pitch * 0.92 };
		}
		draw();
		const moving = progress < 1 || swaying || Math.abs(spin.yaw) > 1e-4 || Math.abs(spin.pitch) > 1e-4;
		if (moving) schedule();
	}

	function schedule(): void {
		if (frame === 0 && !disposed) frame = requestAnimationFrame(step);
	}

	function pointAt(event: { clientX: number; clientY: number }): [number, number] {
		const rect = canvas.getBoundingClientRect();
		return [event.clientX - rect.left, event.clientY - rect.top];
	}

	/** The pin within a few pixels of the pointer, else the leaf whose claim is strongest under it. */
	function siteAt(sx: number, sy: number): GlobeSite | null {
		const m = rotation();
		const maxDepth = view.k < 1.4 ? 1 : view.k < 2.4 ? 2 : 3;
		for (const site of pins) {
			if (site.node.depth > maxDepth) continue;
			const point = toScreen(m, site.at);
			if (point.z > 0.18 && Math.hypot(point.x - sx, point.y - sy) < 8) return site;
		}
		const at = fromScreen(m, sx, sy);
		if (at === null) return null;
		let best: GlobeSite | null = null;
		let bestClaim = 0;
		for (const site of leaves) {
			const chord = 2 - 2 * dot(site.at, at);
			const claim = 1 - chord / (2 - 2 * Math.cos(site.reach));
			if (claim > bestClaim) {
				bestClaim = claim;
				best = site;
			}
		}
		// Open ocean names nothing; a cell of the scope's sea or land names who holds it.
		return best !== null && (texture.owner[cellAt(texture, at)] ?? -1) >= 0 ? best : null;
	}

	let drag: { x: number; y: number; yaw: number; pitch: number; moved: boolean } | null = null;
	const onWheel = (event: WheelEvent): void => {
		event.preventDefault();
		view.k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * Math.exp(-event.deltaY * 0.0015)));
		schedule();
	};
	const onPointerDown = (event: PointerEvent): void => {
		const [sx, sy] = pointAt(event);
		drag = { x: sx, y: sy, yaw: view.yaw, pitch: view.pitch, moved: false };
		spin = { yaw: 0, pitch: 0 };
		canvas.setPointerCapture?.(event.pointerId);
	};
	let lastMove = { x: 0, y: 0 };
	const onPointerMove = (event: PointerEvent): void => {
		const [sx, sy] = pointAt(event);
		if (drag !== null) {
			if (Math.hypot(sx - drag.x, sy - drag.y) > 3) drag.moved = true;
			if (!drag.moved) return;
			swaying = false;
			const r = Math.max(1, radius());
			view.yaw = drag.yaw - (sx - drag.x) / r;
			view.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, drag.pitch + (sy - drag.y) / r));
			spin = { yaw: -(sx - lastMove.x) / r, pitch: (sy - lastMove.y) / r };
			lastMove = { x: sx, y: sy };
			options.onHover(null);
			schedule();
			return;
		}
		lastMove = { x: sx, y: sy };
		const found = siteAt(sx, sy);
		if (found !== hovered) {
			hovered = found;
			schedule();
		}
		if (found === null) options.onHover(null);
		else {
			const point = toScreen(rotation(), found.at);
			// A pin anchors the tooltip; a region follows the pointer, since its center may be far off.
			options.onHover({ node: found.node, x: found.leaf ? sx : point.x, y: found.leaf ? sy : point.y });
		}
	};
	const onPointerUp = (event: PointerEvent): void => {
		drag = null;
		canvas.releasePointerCapture?.(event.pointerId);
		schedule();
	};
	const onPointerLeave = (): void => {
		if (drag !== null) return;
		hovered = null;
		options.onHover(null);
		schedule();
	};

	canvas.addEventListener("wheel", onWheel, { passive: false });
	canvas.addEventListener("pointerdown", onPointerDown);
	canvas.addEventListener("pointermove", onPointerMove);
	canvas.addEventListener("pointerup", onPointerUp);
	canvas.addEventListener("pointerleave", onPointerLeave);
	const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
	observer?.observe(canvas);
	if (progress >= 1) options.onProgress?.(1);
	resize();

	return {
		fit() {
			view.yaw = homeView.yaw;
			view.pitch = homeView.pitch;
			view.k = 1;
			spin = { yaw: 0, pitch: 0 };
			swaying = !options.reducedMotion;
			swayStart = performance.now();
			schedule();
		},
		dispose() {
			disposed = true;
			if (frame !== 0) cancelAnimationFrame(frame);
			observer?.disconnect();
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("pointerdown", onPointerDown);
			canvas.removeEventListener("pointermove", onPointerMove);
			canvas.removeEventListener("pointerup", onPointerUp);
			canvas.removeEventListener("pointerleave", onPointerLeave);
		},
	};
}
