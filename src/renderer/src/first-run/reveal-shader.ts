/**
 * The reveal's choreography solver and the in-window light renderer.
 *
 * `computeRevealState(t)` turns the reveal clock into everything the reveal moves: the ready screen's parts, the
 * light's frame (shared with the desktop windows behind the app, `src/shared/reveal-light.ts`), the "Dazzi" letters
 * and the Finder rising out of the light. `createRevealLightRenderer` draws the light inside the Dazzi window with
 * the same shader the desktop windows run, in screen coordinates, so the two meet without a seam. Without WebGL it
 * falls back to a plain Canvas 2D dusk and glow with the same window cut.
 */

import { REVEAL_LIGHT_FRAGMENT, REVEAL_LIGHT_VERTEX, type RevealLightFrame, type RevealLightScene } from "../../../shared/reveal-light";
import { REVEAL_T, easeInOut, easeOut, progressIn, revealPhaseAt, spring, type RevealPhase } from "./reveal-timing";

/** The strongest the dusk gets inside the Dazzi window, over the faded ready screen. */
export const WINDOW_DUSK_MAX = 0.96;

export interface GlyphState {
	readonly opacity: number;
	readonly y: number;
	readonly blur: number;
}

export interface RevealState {
	readonly phase: RevealPhase;
	/** The ready screen's own background `[0..1]`. */
	readonly readyBg: number;
	/** Each ready text's fade progress (title, lead, start button) `[0..1]`. */
	readonly textOut: readonly number[];
	readonly logo: {
		/** How far it has glided to the centre `[0..1]`. */
		readonly move: number;
		readonly opacity: number;
		/** Degrees. */
		readonly rotate: number;
	};
	readonly word: { readonly opacity: number; readonly blur: number };
	readonly light: RevealLightFrame;
	readonly finder: {
		readonly visible: boolean;
		readonly y: number;
		readonly scale: number;
		readonly blur: number;
		readonly itemProgress: readonly number[];
	};
	readonly tourTriggered: boolean;
}

const ITEM_COUNT = 4;

/** Every value the reveal draws at clock time `t` (seconds). */
export function computeRevealState(t: number): RevealState {
	const T = REVEAL_T;
	const textOut = [0, 1, 2].map((index) => progressIn(t, [T.textOut[0] + index * 0.06, T.textOut[1] + index * 0.06], easeOut));
	const move = progressIn(t, T.logoMove, easeInOut);
	const markOut = progressIn(t, T.markOut, easeInOut);
	const wordOut = progressIn(t, T.wordOut, easeInOut);
	const open = t >= T.open ? 1 : 0;
	const rise = progressIn(t, T.rise, easeOut);
	const focus = progressIn(t, T.focus, easeOut);
	const dusk = progressIn(t, T.dusk, easeInOut) * (1 - progressIn(t, T.duskOut, easeInOut));
	const light = (0.92 * progressIn(t, T.lightIn, easeInOut) + 0.08 * progressIn(t, T.lightFull, easeInOut)) * (1 - progressIn(t, T.lightOut, easeInOut));
	const glow = progressIn(t, T.glowIn, easeOut) * (1 - progressIn(t, T.glowOut, easeInOut));

	return {
		phase: revealPhaseAt(t),
		readyBg: 1 - progressIn(t, T.dusk, easeInOut),
		textOut,
		logo: { move, opacity: 1 - markOut, rotate: T.markTurn * markOut },
		word: { opacity: 1 - wordOut, blur: 8 * wordOut },
		light: {
			time: t,
			dusk,
			light,
			spread: progressIn(t, T.spread, easeInOut),
			glow,
			rise,
			open,
		},
		finder: {
			visible: open === 1,
			y: T.riseOffset * (1 - rise),
			scale: 1 - T.riseScale * (1 - rise),
			blur: T.focusBlur * (1 - focus),
			itemProgress: Array.from({ length: ITEM_COUNT }, (_, index) =>
				progressIn(t, [T.items[0] + index * T.itemStep, T.items[1] + index * T.itemStep], easeOut),
			),
		},
		tourTriggered: t >= T.end,
	};
}

/** Each letter of the word springs up into place, one after another. */
export function computeGlyphStates(word: string, t: number): GlyphState[] {
	return Array.from(word).map((_, index) => {
		const elapsed = t - (REVEAL_T.word + index * REVEAL_T.letterStep);
		const s = spring(elapsed);
		const fade = Math.max(0, Math.min(1, elapsed / 0.35));
		return { opacity: fade, y: 14 * (1 - s), blur: 6 * (1 - fade) };
	});
}

export interface RevealLightRenderer {
	readonly backend: "webgl" | "canvas2d";
	render(scene: RevealLightScene, frame: RevealLightFrame): void;
	dispose(): void;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
	const shader = gl.createShader(type);
	if (shader === null) return null;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		gl.deleteShader(shader);
		return null;
	}
	return shader;
}

function fitCanvas(canvas: HTMLCanvasElement): { width: number; height: number; dpr: number } {
	// The light is soft, so one sample per CSS pixel is plenty; on a 2x display that is a quarter of the work.
	const dpr = Math.min(1, window.devicePixelRatio || 1);
	const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
	const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	return { width, height, dpr };
}

const UNIFORMS = ["u_res", "u_dpr", "u_origin", "u_window", "u_unit", "u_duskMax", "u_time", "u_dusk", "u_light", "u_spread", "u_glow", "u_rise", "u_open"] as const;

function createWebGlRenderer(canvas: HTMLCanvasElement): RevealLightRenderer | null {
	const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
	if (gl === null) return null;
	const vs = compile(gl, gl.VERTEX_SHADER, REVEAL_LIGHT_VERTEX);
	const fs = compile(gl, gl.FRAGMENT_SHADER, REVEAL_LIGHT_FRAGMENT);
	if (vs === null || fs === null) return null;
	const program = gl.createProgram();
	if (program === null) return null;
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
	const position = gl.getAttribLocation(program, "a_pos");
	const loc = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;

	return {
		backend: "webgl",
		render(scene, frame) {
			const { width, height, dpr } = fitCanvas(canvas);
			gl.viewport(0, 0, width, height);
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.useProgram(program);
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.enableVertexAttribArray(position);
			gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
			gl.uniform2f(loc.u_res, width, height);
			gl.uniform1f(loc.u_dpr, dpr);
			gl.uniform2f(loc.u_origin, scene.originX, scene.originY);
			gl.uniform4f(loc.u_window, scene.windowX, scene.windowY, scene.windowWidth, scene.windowHeight);
			gl.uniform1f(loc.u_unit, scene.unit);
			gl.uniform1f(loc.u_duskMax, scene.duskMax);
			gl.uniform1f(loc.u_time, frame.time);
			gl.uniform1f(loc.u_dusk, frame.dusk);
			gl.uniform1f(loc.u_light, frame.light);
			gl.uniform1f(loc.u_spread, frame.spread);
			gl.uniform1f(loc.u_glow, frame.glow);
			gl.uniform1f(loc.u_rise, frame.rise);
			gl.uniform1f(loc.u_open, frame.open);
			gl.drawArrays(gl.TRIANGLES, 0, 6);
		},
		dispose() {
			gl.deleteBuffer(buffer);
			gl.deleteProgram(program);
			gl.deleteShader(vs);
			gl.deleteShader(fs);
		},
	};
}

function createCanvas2dRenderer(canvas: HTMLCanvasElement): RevealLightRenderer | null {
	const ctx = canvas.getContext("2d");
	if (ctx === null) return null;
	return {
		backend: "canvas2d",
		render(scene, frame) {
			const { width, height, dpr } = fitCanvas(canvas);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			const w = width / dpr;
			const h = height / dpr;
			ctx.clearRect(0, 0, w, h);
			const cx = scene.windowX - scene.originX + scene.windowWidth / 2;
			const cy = scene.windowY - scene.originY + scene.windowHeight / 2;
			ctx.fillStyle = `rgba(6, 7, 13, ${(frame.dusk * scene.duskMax).toFixed(3)})`;
			ctx.fillRect(0, 0, w, h);
			const reach = Math.max(w, h) * (0.15 + 1.1 * frame.spread);
			const field = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
			field.addColorStop(0, `rgba(255, 246, 214, ${frame.light.toFixed(3)})`);
			field.addColorStop(0.45, `rgba(255, 214, 110, ${(0.9 * frame.light).toFixed(3)})`);
			field.addColorStop(0.8, `rgba(150, 200, 255, ${(0.7 * frame.light).toFixed(3)})`);
			field.addColorStop(1, `rgba(150, 200, 255, ${(frame.spread > 0.85 ? 0.7 * frame.light : 0).toFixed(3)})`);
			ctx.fillStyle = field;
			ctx.fillRect(0, 0, w, h);
			if (frame.open >= 0.5) {
				// The window's outline, cut crisply out of the light.
				const scale = 1 - REVEAL_T.riseScale * (1 - frame.rise);
				const ww = scene.windowWidth * scale;
				const wh = scene.windowHeight * scale;
				const x = cx - ww / 2;
				const y = cy - wh / 2 + REVEAL_T.riseOffset * (1 - frame.rise);
				ctx.save();
				ctx.globalCompositeOperation = "destination-out";
				ctx.fillStyle = "#000";
				ctx.beginPath();
				ctx.roundRect(x, y, ww, wh, 12 * scale);
				ctx.fill();
				ctx.restore();
			}
		},
		dispose() {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
		},
	};
}

/** The light inside the Dazzi window: WebGL when it can, a plain Canvas 2D dusk and glow otherwise. */
export function createRevealLightRenderer(canvas: HTMLCanvasElement): RevealLightRenderer | null {
	try {
		return createWebGlRenderer(canvas) ?? createCanvas2dRenderer(canvas);
	} catch {
		return createCanvas2dRenderer(canvas);
	}
}
