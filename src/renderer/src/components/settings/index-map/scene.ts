/**
 * The index map's canvas: a force layout of the scope's tree (parent links
 * plus a web between siblings) that settles into continents, painted as
 * territories (`territory.ts`) under a night sky, with the tree's links and
 * nodes drawn over the land like constellations.
 *
 * Imperative on purpose: the layout ticks and the canvas repaints every frame
 * while the land settles, which React state would only slow down. The modal
 * owns one scene per map and disposes it on close.
 */

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { IndexMap, IndexMapNode } from "../../../../../shared/index-map-contract";
import { paintTerritory, TERRITORY_COLORS, type TerritoryClaim } from "./territory";

interface Body extends SimulationNodeDatum {
	readonly node: IndexMapNode;
	/** Drawn radius in world units. */
	readonly radius: number;
	/** How far its territory reaches, in world units. */
	readonly reach: number;
	x: number;
	y: number;
}

interface Tie extends SimulationLinkDatum<Body> {
	readonly source: Body;
	readonly target: Body;
	/** Parent → child, or a sibling strand of the web. */
	readonly tree: boolean;
}

export interface SceneHover {
	readonly node: IndexMapNode;
	/** CSS pixels inside the canvas. */
	readonly x: number;
	readonly y: number;
}

export interface IndexMapScene {
	/** Frame the whole map again. */
	fit(): void;
	dispose(): void;
}

/** Territory grid cell, in CSS pixels: coarse enough to repaint every frame, smoothed when scaled up. */
const CELL = 3;
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 8;

function bodyRadius(node: IndexMapNode): number {
	switch (node.kind) {
		case "root":
			return 11 + Math.min(16, Math.sqrt(node.weight) * 0.6);
		case "folder":
			return 5 + Math.min(18, Math.sqrt(node.weight) * 0.9);
		case "parcel":
			return Math.min(80, 4 + Math.sqrt(node.weight) * 4.2);
		case "file":
			return 4;
	}
}

/** Deterministic 0..1 noise so the starfield and first positions are the same on every open. */
function hash(seed: number): number {
	const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
	return value - Math.floor(value);
}

function rgba([r, g, b]: readonly [number, number, number], alpha: number): string {
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function createIndexMapScene(
	canvas: HTMLCanvasElement,
	map: IndexMap,
	options: { readonly reducedMotion: boolean; readonly onHover: (hover: SceneHover | null) => void },
): IndexMapScene {
	const context = canvas.getContext("2d");
	const bodies: Body[] = [];
	const ties: Tie[] = [];
	const children = new Map<number, Body[]>();
	for (const node of map.nodes) {
		const parent = node.parent === null ? undefined : bodies[node.parent];
		const radius = bodyRadius(node);
		// Children start on a golden-angle spiral around their parent, so the first frames unfold instead of exploding.
		const siblings = parent === undefined ? [] : (children.get(parent.node.id) ?? []);
		const angle = (siblings.length + 1) * 2.399963 + hash(node.id) * 0.4;
		const distance = parent === undefined ? 0 : parent.radius + radius + 10 + Math.sqrt(siblings.length) * 9;
		const rootOffset = node.parent === null ? map.nodes.filter((other) => other.parent === null && other.id < node.id).length : 0;
		const body: Body = {
			node,
			radius,
			reach: node.kind === "file" ? radius * 3.2 : node.kind === "parcel" ? radius * 1.7 : radius * 2.6,
			x: parent === undefined ? Math.cos(rootOffset * 2.4) * rootOffset * 220 : parent.x + Math.cos(angle) * distance,
			y: parent === undefined ? Math.sin(rootOffset * 2.4) * rootOffset * 220 : parent.y + Math.sin(angle) * distance,
		};
		bodies.push(body);
		if (parent !== undefined) {
			siblings.push(body);
			children.set(parent.node.id, siblings);
			ties.push({ source: parent, target: body, tree: true });
		}
	}
	// The web: each child is tied to the next one of the same parent, closing a ring, so a folder's files knit into one piece of land.
	for (const group of children.values()) {
		if (group.length < 3) continue;
		for (let index = 0; index < group.length; index += 1) {
			const source = group[index];
			const target = group[(index + 1) % group.length];
			if (source !== undefined && target !== undefined) ties.push({ source, target, tree: false });
		}
	}

	const simulation: Simulation<Body, Tie> = forceSimulation(bodies)
		.force(
			"link",
			forceLink<Body, Tie>(ties)
				.distance((tie) => (tie.tree ? tie.source.radius + tie.target.radius + 6 : tie.source.radius + tie.target.radius + 4))
				.strength((tie) => (tie.tree ? 0.85 : 0.22)),
		)
		.force("charge", forceManyBody<Body>().strength((body) => -10 - body.radius * 1.6).distanceMax(360))
		.force("collide", forceCollide<Body>((body) => body.radius + 1.5).strength(0.9))
		.force("x", forceX<Body>(0).strength(0.035))
		.force("y", forceY<Body>(0).strength(0.035))
		.alphaDecay(0.018)
		.stop();

	let width = 0;
	let height = 0;
	let dpr = 1;
	const camera = { x: 0, y: 0, k: 1 };
	/** The camera follows the growing land until the person pans or zooms. */
	let following = true;
	let hovered: Body | null = null;
	let frame = 0;
	let disposed = false;
	const land = document.createElement("canvas");
	const landContext = land.getContext("2d");
	const stars = Array.from({ length: 220 }, (_, index) => ({ x: hash(index * 3 + 1), y: hash(index * 3 + 2), size: 0.3 + hash(index * 3 + 3) * 1.1, twinkle: hash(index * 7) }));

	function bounds(): { x0: number; y0: number; x1: number; y1: number } {
		let x0 = Number.POSITIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (const body of bodies) {
			x0 = Math.min(x0, body.x - body.reach);
			y0 = Math.min(y0, body.y - body.reach);
			x1 = Math.max(x1, body.x + body.reach);
			y1 = Math.max(y1, body.y + body.reach);
		}
		return bodies.length === 0 ? { x0: -1, y0: -1, x1: 1, y1: 1 } : { x0, y0, x1, y1 };
	}

	function fitTarget(): { x: number; y: number; k: number } {
		const box = bounds();
		const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((width * 0.86) / (box.x1 - box.x0), (height * 0.82) / (box.y1 - box.y0))));
		return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, k: Math.min(k, 2.4) };
	}

	const toScreen = (x: number, y: number): [number, number] => [(x - camera.x) * camera.k + width / 2, (y - camera.y) * camera.k + height / 2];

	function resize(): void {
		const rect = canvas.getBoundingClientRect();
		dpr = window.devicePixelRatio || 1;
		width = Math.max(1, rect.width);
		height = Math.max(1, rect.height);
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		schedule();
	}

	function drawSky(ctx: CanvasRenderingContext2D, time: number): void {
		const sky = ctx.createRadialGradient(width * 0.5, height * 0.42, 0, width * 0.5, height * 0.5, Math.max(width, height) * 0.75);
		sky.addColorStop(0, "#0f1b33");
		sky.addColorStop(0.55, "#091225");
		sky.addColorStop(1, "#04070f");
		ctx.fillStyle = sky;
		ctx.fillRect(0, 0, width, height);
		for (const star of stars) {
			// The sky drifts a little with the camera, slower than the land.
			const x = (((star.x * width - camera.x * camera.k * 0.04) % width) + width) % width;
			const y = (((star.y * height - camera.y * camera.k * 0.04) % height) + height) % height;
			const glow = options.reducedMotion ? 0.55 : 0.35 + 0.35 * Math.sin(time / 900 + star.twinkle * 40);
			ctx.fillStyle = `rgba(210, 225, 255, ${glow * (0.4 + star.size * 0.4)})`;
			ctx.beginPath();
			ctx.arc(x, y, star.size, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	function drawLand(ctx: CanvasRenderingContext2D): void {
		if (landContext === null) return;
		const gridWidth = Math.ceil(width / CELL);
		const gridHeight = Math.ceil(height / CELL);
		const claims: TerritoryClaim[] = [];
		for (const body of bodies) {
			const [x, y] = toScreen(body.x, body.y);
			const reach = (body.reach * camera.k) / CELL;
			if (x / CELL + reach < 0 || y / CELL + reach < 0 || x / CELL - reach > gridWidth || y / CELL - reach > gridHeight) continue;
			// A root or folder claims for the state most of its files are in; a file or parcel for its own.
			claims.push({ x: x / CELL, y: y / CELL, radius: Math.max(1.2, reach), state: body.node.state });
		}
		const grid = paintTerritory(gridWidth, gridHeight, claims);
		land.width = gridWidth;
		land.height = gridHeight;
		landContext.putImageData(new ImageData(grid.pixels, gridWidth, gridHeight), 0, 0);
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
		// Shallow water: the land, blurred and faint, glows into the sea around the coast.
		ctx.save();
		ctx.filter = "blur(14px)";
		ctx.globalAlpha = 0.55;
		ctx.drawImage(land, 0, 0, gridWidth * CELL, gridHeight * CELL);
		ctx.restore();
		ctx.drawImage(land, 0, 0, gridWidth * CELL, gridHeight * CELL);
	}

	function drawWeb(ctx: CanvasRenderingContext2D): void {
		const ancestors = new Set<number>();
		for (let id: number | null = hovered?.node.id ?? null; id !== null; id = map.nodes[id]?.parent ?? null) ancestors.add(id);
		ctx.lineCap = "round";
		for (const tie of ties) {
			const [x0, y0] = toScreen(tie.source.x, tie.source.y);
			const [x1, y1] = toScreen(tie.target.x, tie.target.y);
			const lit = tie.tree && ancestors.has(tie.source.node.id) && ancestors.has(tie.target.node.id);
			ctx.strokeStyle = lit ? "rgba(255, 244, 214, 0.9)" : tie.tree ? "rgba(214, 228, 255, 0.2)" : "rgba(214, 228, 255, 0.07)";
			ctx.lineWidth = lit ? 1.6 : tie.tree ? Math.min(1.2, 0.5 + camera.k * 0.3) : 0.6;
			ctx.beginPath();
			ctx.moveTo(x0, y0);
			ctx.lineTo(x1, y1);
			ctx.stroke();
		}
	}

	function drawStars(ctx: CanvasRenderingContext2D): void {
		for (const body of bodies) {
			const [x, y] = toScreen(body.x, body.y);
			if (x < -40 || y < -40 || x > width + 40 || y > height + 40) continue;
			const color = TERRITORY_COLORS[body.node.state];
			const hub = body.node.kind === "root" || body.node.kind === "folder";
			if (hub) {
				const size = Math.max(2.2, body.radius * camera.k * 0.42);
				const halo = ctx.createRadialGradient(x, y, 0, x, y, size * 3.4);
				halo.addColorStop(0, "rgba(255, 255, 255, 0.85)");
				halo.addColorStop(0.25, rgba(color, 0.55));
				halo.addColorStop(1, rgba(color, 0));
				ctx.fillStyle = halo;
				ctx.beginPath();
				ctx.arc(x, y, size * 3.4, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillStyle = "#ffffff";
				ctx.beginPath();
				ctx.arc(x, y, size * 0.55, 0, Math.PI * 2);
				ctx.fill();
			} else {
				const size = body.node.kind === "parcel" ? Math.max(1.6, Math.min(5, body.radius * camera.k * 0.12)) : Math.max(0.9, Math.min(2.6, camera.k * 1.3));
				ctx.fillStyle = rgba([Math.min(255, color[0] + 110), Math.min(255, color[1] + 110), Math.min(255, color[2] + 110)], 0.9);
				ctx.beginPath();
				ctx.arc(x, y, size, 0, Math.PI * 2);
				ctx.fill();
			}
			if (body === hovered) {
				ctx.strokeStyle = "rgba(255, 244, 214, 0.95)";
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.arc(x, y, Math.max(7, body.radius * camera.k * 0.6), 0, Math.PI * 2);
				ctx.stroke();
			}
		}
	}

	function drawLabels(ctx: CanvasRenderingContext2D): void {
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		// Roots first, then the heavier folders: a label that would overlap one already drawn waits for more zoom.
		const named = bodies
			.filter(({ node }) => node.kind === "root" || (node.kind === "folder" && camera.k >= 0.55 + node.depth * 0.45))
			.sort((a, b) => Number(b.node.kind === "root") - Number(a.node.kind === "root") || b.node.weight - a.node.weight);
		const placed: { left: number; top: number; right: number; bottom: number }[] = [];
		for (const body of named) {
			const { node } = body;
			const [x, y] = toScreen(body.x, body.y);
			if (x < -80 || y < -20 || x > width + 80 || y > height + 20) continue;
			const root = node.kind === "root";
			ctx.font = root ? "600 13px system-ui, -apple-system, sans-serif" : "500 11px system-ui, -apple-system, sans-serif";
			const label = root ? node.name.split(/[\\/]/u).filter(Boolean).at(-1) ?? node.name : node.name;
			const top = y + Math.max(6, body.radius * camera.k * 0.5) + 6;
			const half = ctx.measureText(label).width / 2 + 3;
			const box = { left: x - half, top: top - 1, right: x + half, bottom: top + (root ? 16 : 14) };
			if (placed.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
			placed.push(box);
			ctx.lineWidth = 3;
			ctx.strokeStyle = "rgba(4, 8, 18, 0.85)";
			ctx.strokeText(label, x, top);
			ctx.fillStyle = root ? "rgba(255, 250, 235, 0.98)" : "rgba(226, 234, 250, 0.86)";
			ctx.fillText(label, x, top);
		}
	}

	function draw(time: number): void {
		if (context === null) return;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawSky(context, time);
		drawLand(context);
		drawWeb(context);
		drawStars(context);
		drawLabels(context);
	}

	function step(time: number): void {
		frame = 0;
		if (disposed) return;
		const settling = simulation.alpha() > simulation.alphaMin();
		if (settling) simulation.tick(options.reducedMotion ? 0 : 1);
		if (following) {
			const target = fitTarget();
			const ease = options.reducedMotion ? 1 : 0.12;
			camera.x += (target.x - camera.x) * ease;
			camera.y += (target.y - camera.y) * ease;
			camera.k += (target.k - camera.k) * ease;
		}
		draw(time);
		const easing = following && Math.abs(fitTarget().k - camera.k) > 0.002;
		if ((settling || easing) && !options.reducedMotion) schedule();
	}

	function schedule(): void {
		if (frame === 0 && !disposed) frame = requestAnimationFrame(step);
	}

	function pointAt(event: { clientX: number; clientY: number }): [number, number] {
		const rect = canvas.getBoundingClientRect();
		return [event.clientX - rect.left, event.clientY - rect.top];
	}

	let drag: { x: number; y: number; cameraX: number; cameraY: number } | null = null;
	const onWheel = (event: WheelEvent): void => {
		event.preventDefault();
		following = false;
		const [sx, sy] = pointAt(event);
		const wx = (sx - width / 2) / camera.k + camera.x;
		const wy = (sy - height / 2) / camera.k + camera.y;
		camera.k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.k * Math.exp(-event.deltaY * 0.0015)));
		// Zoom about the pointer: the world point under it stays under it.
		camera.x = wx - (sx - width / 2) / camera.k;
		camera.y = wy - (sy - height / 2) / camera.k;
		schedule();
	};
	const onPointerDown = (event: PointerEvent): void => {
		const [sx, sy] = pointAt(event);
		drag = { x: sx, y: sy, cameraX: camera.x, cameraY: camera.y };
		canvas.setPointerCapture?.(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent): void => {
		const [sx, sy] = pointAt(event);
		if (drag !== null) {
			following = false;
			camera.x = drag.cameraX - (sx - drag.x) / camera.k;
			camera.y = drag.cameraY - (sy - drag.y) / camera.k;
			schedule();
			return;
		}
		const wx = (sx - width / 2) / camera.k + camera.x;
		const wy = (sy - height / 2) / camera.k + camera.y;
		const found = simulation.find(wx, wy, Math.max(10, 18 / camera.k)) ?? null;
		if (found !== hovered) {
			hovered = found;
			schedule();
		}
		if (found === null) options.onHover(null);
		else {
			const [hx, hy] = toScreen(found.x, found.y);
			options.onHover({ node: found.node, x: hx, y: hy });
		}
	};
	const onPointerUp = (event: PointerEvent): void => {
		drag = null;
		canvas.releasePointerCapture?.(event.pointerId);
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

	if (options.reducedMotion) {
		// No motion: settle the layout before the first frame and show only the result.
		simulation.tick(Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())));
	}
	resize();

	return {
		fit() {
			following = true;
			schedule();
		},
		dispose() {
			disposed = true;
			if (frame !== 0) cancelAnimationFrame(frame);
			observer?.disconnect();
			simulation.stop();
			canvas.removeEventListener("wheel", onWheel);
			canvas.removeEventListener("pointerdown", onPointerDown);
			canvas.removeEventListener("pointermove", onPointerMove);
			canvas.removeEventListener("pointerup", onPointerUp);
			canvas.removeEventListener("pointerleave", onPointerLeave);
		},
	};
}
