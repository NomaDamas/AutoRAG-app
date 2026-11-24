/**
 * Arc / Dia × Dazzi WebGL GLSL shader renderer and choreography state solver.
 *
 * Visually modeled after The Browser Company's Arc & Dia onboarding intros and
 * macOS Liquid Glass optical refraction, anchored on Dazzi's sunflower-in-glass-tile brand:
 * - One full-viewport premultiplied-alpha WebGL shader canvas renders:
 *   1. Deep obsidian backdrop fading smoothly over the ready stage.
 *   2. Volumetric flowing liquid-glass orb (simplex fBM domain-warped light field in
 *      Dazzi's signature warm sunlight gold + crystal ice-blue + soft lavender prism).
 *   3. Subtle specular caustic halo around the centered Dazzi sunflower.
 *   4. Arc's organic melting reveal: a noise-warped non-uniform aperture melts outward
 *      from the Dazzi logo, lined by a delicate golden/ice Fresnel dispersion rim,
 *      dropping fragment alpha to 0 so the real Finder underneath emerges seamlessly.
 *   5. Micro analog film grain to eliminate 8-bit gradient banding.
 * - Falls back gracefully to a smooth Canvas 2D organic melt mask if WebGL is unavailable.
 */

import {
	REVEAL_T,
	easeInOut,
	easeLift,
	easeOut,
	easeSpring,
	glyphProgress,
	progressIn,
	revealPhaseAt,
	type RevealPhase,
} from "./reveal-timing";

export interface ArcShaderUniforms {
	readonly alpha: number;
	readonly darkness: number;
	readonly orbRadius: number;
	readonly orbIntensity: number;
	readonly meltProgress: number;
	readonly rimGlow: number;
	readonly prismShift: number;
}

export interface ArcRevealState {
	readonly phase: RevealPhase;
	readonly readyBgOpacity: number;
	/** OS-wide desktop dimmer opacity `[0..0.88]` driven in sync with the reveal spotlight. */
	readonly desktopBackdrop: number;
	readonly shader: ArcShaderUniforms;
	readonly logo: {
		readonly move: number;
		readonly scale: number;
		readonly opacity: number;
		readonly blur: number;
		readonly halo: number;
	};
	readonly sweep: number;
	readonly wordLift: {
		readonly opacity: number;
		readonly blur: number;
		readonly scale: number;
		readonly y: number;
	};
	readonly finder: {
		readonly opacity: number;
		readonly scale: number;
		readonly blur: number;
		readonly itemProgress: readonly [number, number, number, number];
	};
	readonly tourTriggered: boolean;
}

export interface GlyphFrameState {
	readonly char: string;
	readonly opacity: number;
	readonly blur: number;
	readonly y: number;
	readonly rotateZ: number;
	readonly scale: number;
}

export interface ArcShaderRenderer {
	readonly backend: "webgl" | "canvas2d";
	render(width: number, height: number, dpr: number, state: ArcRevealState, timeSec: number): void;
	dispose(): void;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

export const ARC_VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
	v_uv = a_pos * 0.5 + 0.5;
	gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/**
 * Fragment shader: Arc/Dia luminous simplex-fluid glass orb + Dazzi solar/ice prism +
 * Krzysztof Zabłocki / Arc organic non-uniform melting aperture into the live Finder.
 * Outputs premultiplied RGBA so WebGL composites smoothly over the DOM Finder behind it.
 */
export const ARC_FRAGMENT_SHADER = `
precision highp float;

varying vec2 v_uv;

uniform vec2 u_res;
uniform float u_time;
uniform float u_alpha;
uniform float u_darkness;
uniform float u_orbRadius;
uniform float u_orbIntensity;
uniform float u_melt;
uniform float u_rimGlow;
uniform float u_prismShift;

// 2D Simplex noise (Ashima / Gustavson) for silky organic fluid motion
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
	const vec4 C = vec4(
		0.211324865405187,
		0.366025403784439,
		-0.577350269189626,
		0.024390243902439
	);
	vec2 i = floor(v + dot(v, C.yy));
	vec2 x0 = v - i + dot(i, C.xx);
	vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
	vec4 x12 = x0.xyxy + C.xxzz;
	x12.xy -= i1;
	i = mod289(i);
	vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
	vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
	m = m * m;
	m = m * m;
	vec3 x = 2.0 * fract(p * C.www) - 1.0;
	vec3 h = abs(x) - 0.5;
	vec3 ox = floor(x + 0.5);
	vec3 a0 = x - ox;
	m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
	vec3 g;
	g.x = a0.x * x0.x + h.x * x0.y;
	g.yz = a0.yz * x12.xz + h.yz * x12.yw;
	return 130.0 * dot(m, g);
}

float fbm(vec2 p) {
	float v = 0.0;
	float amp = 0.52;
	mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
	for (int i = 0; i < 4; i++) {
		v += amp * snoise(p);
		p = rot * p * 2.02 + vec2(0.17, -0.11);
		amp *= 0.5;
	}
	return v;
}

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
	if (u_alpha <= 0.001) {
		gl_FragColor = vec4(0.0);
		return;
	}

	// Aspect-corrected coordinates centered on the Dazzi sunflower (16px above viewport mid)
	float aspect = u_res.x / max(1.0, u_res.y);
	vec2 center = vec2(0.5, 0.5 + 16.0 / max(1.0, u_res.y));
	vec2 p = v_uv - center;
	p.x *= aspect;

	float dist = length(p);
	float angle = atan(p.y, p.x);
	float maxDiag = length(vec2(aspect * 0.56, 0.56));

	// Slow domain-warped organic field (Arc/Dia liquid silk motion)
	vec2 warp = vec2(
		fbm(p * 1.85 + vec2(u_time * 0.24, -u_time * 0.16)),
		fbm(p * 1.85 + vec2(-u_time * 0.19, u_time * 0.22) + vec2(4.2, 1.9))
	);
	float fluid = fbm(p * 2.15 + warp * 0.62 + vec2(0.0, u_time * 0.12));

	// 1. Deep cinema obsidian canvas with volumetric sapphire-to-indigo depth
	vec3 obsidian = vec3(0.022, 0.026, 0.045);
	vec3 deepSapphire = vec3(0.055, 0.11, 0.25);
	vec3 royalIndigo = vec3(0.095, 0.068, 0.20);
	vec3 bg = obsidian
		+ deepSapphire * smoothstep(1.35, 0.05, length(p - vec2(0.36 * aspect, -0.32))) * 0.62
		+ royalIndigo * smoothstep(1.25, 0.05, length(p - vec2(-0.36 * aspect, 0.30))) * 0.45;

	// Subtle volumetric light rays rotating gently behind the glass orb (solar corona beams)
	float ray1 = pow(0.5 + 0.5 * sin(angle * 6.0 - u_time * 0.55 + warp.x * 1.4), 4.0);
	float ray2 = pow(0.5 + 0.5 * cos(angle * 4.0 + u_time * 0.38 - warp.y * 1.2), 3.0);
	float rayFalloff = exp(-dist * 2.1) * smoothstep(0.04, 0.22, dist);
	vec3 coronaRays = (vec3(1.0, 0.80, 0.36) * ray1 * 0.16 + vec3(0.42, 0.72, 1.0) * ray2 * 0.14) * rayFalloff * u_orbIntensity;

	// 2. Physical 3D Liquid-Glass Sphere (Arc/Dia Spline orb × Dazzi icon glass tile)
	float sphereR = max(0.05, u_orbRadius * 0.86);
	float organicR = sphereR * (1.0 + fluid * 0.045 * (0.4 + 0.6 * u_orbIntensity));
	float rn = dist / organicR;
	float insideMask = smoothstep(1.04, 0.94, rn);

	// Analytical hemisphere surface normal N = (px, py, pz) perturbed by liquid glass wave
	float rClamped = min(rn, 0.998);
	float nz = sqrt(max(0.001, 1.0 - rClamped * rClamped));
	vec3 normal = normalize(vec3(p / organicR + warp * 0.09, nz));
	vec3 viewDir = vec3(0.0, 0.0, 1.0);

	// Schlick Fresnel (R0 = 0.06 for crystal glass) + top-left studio key specular + bottom-right warm rim bounce
	float ndotv = clamp(dot(normal, viewDir), 0.0, 1.0);
	float fresnel = pow(1.0 - ndotv, 2.8);
	vec3 keyLight = normalize(vec3(-0.48, 0.62, 0.62));
	vec3 bounceLight = normalize(vec3(0.56, -0.52, 0.45));
	vec3 halfKey = normalize(keyLight + viewDir);
	vec3 halfBounce = normalize(bounceLight + viewDir);
	float specKey = pow(max(dot(normal, halfKey), 0.0), 42.0);
	float specSoft = pow(max(dot(normal, halfKey), 0.0), 8.0);
	float specBounce = pow(max(dot(normal, halfBounce), 0.0), 16.0);

	// Internal liquid silk gradient swirling inside the glass sphere (gold sunlight + ice sapphire + soft violet)
	float internalSwirl = 0.5 + 0.5 * sin(angle * 2.0 - u_time * 1.15 + warp.x * 2.8);
	float internalSwirl2 = 0.5 + 0.5 * cos(angle * 3.0 + u_time * 0.82 - warp.y * 2.4);
	vec3 sunCream = vec3(1.00, 0.96, 0.86);
	vec3 dazziGold = vec3(1.00, 0.77, 0.25);
	vec3 amberSilk = vec3(0.96, 0.49, 0.18);
	vec3 iceBlue = vec3(0.36, 0.69, 1.00);
	vec3 glassLilac = vec3(0.62, 0.54, 0.98);

	// Deep glass interior: rich translucent sapphire-gold dome, darker toward edges for 3D spherical volume
	vec3 glassCore = mix(vec3(0.09, 0.14, 0.28), mix(dazziGold, amberSilk, internalSwirl * 0.6), smoothstep(0.95, 0.1, rn) * 0.58);
	glassCore += mix(iceBlue, glassLilac, internalSwirl2) * (0.28 * smoothstep(0.15, 0.95, rn));
	// Crisp studio glass highlights
	glassCore += sunCream * specKey * 0.95;
	glassCore += mix(iceBlue, sunCream, 0.5) * specSoft * 0.30;
	glassCore += dazziGold * specBounce * 0.48;
	// Iridescent Fresnel bevel around the glass sphere
	glassCore += mix(iceBlue, dazziGold, internalSwirl) * fresnel * 1.15;

	// Chromatic dispersion ring right outside the glass silhouette (RGB split bezel)
	float ringDist = dist - organicR * 0.98;
	float rimR = exp(-pow((ringDist - 0.012 * u_prismShift) / 0.036, 2.0));
	float rimG = exp(-pow(ringDist / 0.032, 2.0));
	float rimB = exp(-pow((ringDist + 0.014 * u_prismShift) / 0.040, 2.0));
	vec3 chromaticBezel = vec3(rimR * 1.02, rimG * 0.92, rimB * 1.10) * mix(iceBlue, dazziGold, internalSwirl) * (0.58 + 0.30 * internalSwirl2);

	// Atmospheric outer halo illuminating the obsidian backdrop
	float outerHalo = exp(-pow(dist / max(0.18, organicR * 1.95), 2.0));
	vec3 haloColor = mix(iceBlue, dazziGold, 0.45 + 0.35 * internalSwirl) * outerHalo * 0.34;

	vec3 orbComposite = glassCore * insideMask + chromaticBezel + haloColor + coronaRays;

	// Highlight-only rolloff so the obsidian stage stays velvety dark (#06070d) and matches the OS desktop dimmer seamlessly
	vec3 orbMapped = orbComposite / (vec3(1.0) + orbComposite * 0.45);
	vec3 col = bg + orbMapped * u_orbIntensity;

	// 3. Arc organic melting aperture (non-uniform simplex-warped hole opening from the Dazzi mark)
	float lobe =
		0.048 * sin(angle * 3.0 + u_time * 0.85) +
		0.032 * cos(angle * 5.0 - u_time * 0.65) +
		0.064 * fluid;

	float meltR = pow(u_melt, 1.32) * (maxDiag * 1.35);
	float feather = mix(0.046, 0.155, u_melt);
	float signedMelt = (dist + lobe * (1.0 - 0.55 * u_melt)) - meltR;

	float veilAlpha = (u_melt <= 0.0005)
		? 1.0
		: smoothstep(-feather, feather, signedMelt);

	// Narrow prismatic liquid-glass wave front along the melting aperture edge
	float edgeBand = exp(-pow(signedMelt / max(0.028, feather * 0.52), 2.0));
	float edgeR = exp(-pow((signedMelt - 0.014) / max(0.032, feather * 0.56), 2.0));
	float edgeB = exp(-pow((signedMelt + 0.014) / max(0.032, feather * 0.56), 2.0));
	vec3 meltRimColor =
		vec3(1.00, 0.94, 0.80) * edgeBand * 0.58 +
		vec3(1.00, 0.72, 0.28) * edgeR * 0.38 +
		vec3(0.38, 0.74, 1.00) * edgeB * 0.52;

	// Micro film grain (eliminates 8-bit banding on smooth obsidian gradients)
	float grain = (hash(gl_FragCoord.xy + fract(u_time) * 19.0) - 0.5) * 0.013;
	col = max(vec3(0.0), col + grain);

	// Compose veil + glowing rim over transparent aperture
	float rimAlpha = edgeBand * u_rimGlow * 0.58;
	float outAlpha = clamp((veilAlpha * u_darkness + rimAlpha) * u_alpha, 0.0, 1.0);
	vec3 finalRgb = col * (veilAlpha * u_darkness) + meltRimColor * (u_rimGlow * 0.68);
	finalRgb *= u_alpha;

	// Premultiplied alpha output
	gl_FragColor = vec4(finalRgb, outAlpha);
}
`;

/** Pure frame-state solver for clock time `rawT` (seconds). */
export function computeArcRevealState(rawT: number): ArcRevealState {
	const t = Math.max(0, rawT);
	const T = REVEAL_T;
	const phase = revealPhaseAt(t);

	// Ready backdrop yields quickly to the WebGL dark obsidian canvas
	const darken = progressIn(t, T.darken, easeInOut);
	const meltProgress = progressIn(t, T.melt, easeInOut);
	const meltOutFade = 1 - progressIn(t, [T.melt[1] - 0.15, T.dim[0]], easeOut);

	const readyBgOpacity = clamp01((1 - progressIn(t, [0.06, 0.68], easeInOut)) * (1 - meltProgress));
	const shaderAlpha = clamp01(progressIn(t, [0.0, 0.42], easeOut) * meltOutFade);
	// OS desktop backdrop dims quickly with the obsidian stage, holds through the orb, and lifts softly as Finder arrives
	const desktopBackdrop = clamp01(
		progressIn(t, [0.02, 0.78], easeInOut) * 0.86 * (1 - progressIn(t, [T.melt[0] + 0.55, T.dim[0] - 0.05], easeInOut)),
	);
	// Luminous orb grows from behind the sunflower, gently breathes, then expands into the melt wave
	const orbIn = progressIn(t, T.orbIn, easeOut);
	const breathe = Math.sin(Math.max(0, t - T.orbIn[0]) * 2.2) * 0.018 * orbIn * (1 - meltProgress);
	const orbRadius = 0.05 + 0.25 * orbIn + 0.24 * meltProgress + breathe;
	const orbIntensity = clamp01(orbIn * (1 - progressIn(t, [T.melt[0] + 0.45, T.melt[1]], easeInOut)));
	const rimGlow = clamp01(
		progressIn(t, [T.melt[0], T.melt[0] + 0.34], easeOut) *
			(1 - progressIn(t, [T.melt[1] - 0.42, T.dim[0] - 0.05], easeInOut)),
	);
	const prismShift = 0.75 + 0.45 * orbIn + 0.4 * meltProgress;

	// Dazzi sunflower hero mark: glides to center, gently swells with optical warmth, then lifts smoothly into the melt
	const move = progressIn(t, T.logoMove, easeOut);
	const heroSettle = progressIn(t, [0.45, 1.45], easeSpring);
	const lift = progressIn(t, T.lift, easeLift);
	const logoScale = 1 + 0.08 * heroSettle + T.liftScale * lift;
	const logoBlur = T.liftBlur * lift;
	const logoOpacity = clamp01((1 - lift) * (1 - progressIn(t, [T.melt[0] + 0.65, T.dim[0] - 0.15], easeInOut)));
	const logoHalo = clamp01(orbIn * (1 - lift));

	// Silk light sweep across the sunflower
	const sweep = progressIn(t, T.sweep, easeInOut);

	// Whole-word lift envelope once the melt opens
	const wordLift = {
		opacity: clamp01(1 - lift),
		blur: (T.liftBlur - 2) * lift,
		scale: 1 + 0.08 * lift,
		y: -8 * lift,
	};

	// Live Finder underneath: pulls softly into sharp focus as the organic melt clears the viewport
	const finderOpacity = progressIn(t, [T.fin[0], T.fin[0] + 0.62], easeInOut);
	const finderFocus = progressIn(t, T.fin, easeOut);
	const itemProgress = [0, 1, 2, 3].map((index) =>
		progressIn(t, [T.items + index * T.itemStep, T.items + index * T.itemStep + 0.65], easeOut),
	) as [number, number, number, number];

	return {
		phase,
		readyBgOpacity,
		desktopBackdrop,
		shader: {
			alpha: shaderAlpha,
			darkness: darken,
			orbRadius,
			orbIntensity,
			meltProgress,
			rimGlow,
			prismShift,
		},
		logo: {
			move,
			scale: logoScale,
			opacity: logoOpacity,
			blur: logoBlur,
			halo: logoHalo,
		},
		sweep,
		wordLift,
		finder: {
			opacity: finderOpacity,
			scale: 1 + T.finScale * (1 - finderFocus),
			blur: T.finBlur * (1 - finderFocus),
			itemProgress,
		},
		tourTriggered: t >= T.dim[0],
	};
}

/**
 * Per-letter staggered 3D spring cascade (Arc/Dia AnimateText style):
 * each letter rises, unblurs, and gently rotates upright from bottom-left pivot.
 */
export function computeGlyphStates(word: string, rawT: number): GlyphFrameState[] {
	const t = Math.max(0, rawT);
	const start = REVEAL_T.word[0];
	const stagger = 0.055;
	const duration = 0.56;
	return Array.from(word).map((char, index) => {
		const p = glyphProgress(t, index, start, stagger, duration);
		const clamped = clamp01(p);
		const inv = 1 - clamped;
		return {
			char,
			opacity: clamped,
			blur: 10 * inv,
			y: 14 * (1 - p),
			rotateZ: 12 * (1 - p),
			scale: 0.92 + 0.08 * p,
		};
	});
}

/** Clean Canvas 2D fallback if WebGL is unavailable (e.g., unit tests or restricted GPUs). */
export function drawFallbackReveal(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	state: ArcRevealState,
	timeSec: number,
): void {
	ctx.clearRect(0, 0, width, height);
	if (width <= 0 || height <= 0 || state.shader.alpha <= 0.002) return;

	const cx = width / 2;
	const cy = height / 2 - 16;
	const maxR = Math.hypot(width, height) * 0.62;
	const { alpha, darkness, orbRadius, orbIntensity, meltProgress, rimGlow } = state.shader;

	ctx.save();
	ctx.globalAlpha = alpha * darkness;
	ctx.fillStyle = "#08090f";
	ctx.fillRect(0, 0, width, height);

	// Warm gold + crystal ice-blue glass orb
	if (orbIntensity > 0.01) {
		const r = orbRadius * Math.min(width, height) * 1.45;
		const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(10, r));
		g.addColorStop(0, `rgba(255, 244, 212, ${0.72 * orbIntensity})`);
		g.addColorStop(0.32, `rgba(255, 198, 76, ${0.44 * orbIntensity})`);
		g.addColorStop(0.62, `rgba(108, 178, 255, ${0.24 * orbIntensity})`);
		g.addColorStop(1, "rgba(8, 9, 15, 0)");
		ctx.globalAlpha = alpha;
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, width, height);
	}

	// Organic multi-lobe melting hole via destination-out
	if (meltProgress > 0.004) {
		const baseR = meltProgress ** 1.35 * maxR * 1.32;
		const traceOrganic = (): void => {
			ctx.beginPath();
			const steps = 64;
			for (let i = 0; i <= steps; i += 1) {
				const a = (i / steps) * Math.PI * 2;
				const wobble = 1 + (0.06 * Math.sin(a * 3 + timeSec * 0.9) + 0.04 * Math.cos(a * 5 - timeSec * 0.7)) * (1 - 0.55 * meltProgress);
				const r = baseR * wobble;
				const x = cx + Math.cos(a) * r;
				const y = cy + Math.sin(a) * r;
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.closePath();
		};

		ctx.save();
		ctx.globalCompositeOperation = "destination-out";
		ctx.fillStyle = "#000";
		traceOrganic();
		ctx.fill();
		ctx.restore();

		if (rimGlow > 0.01) {
			ctx.save();
			ctx.globalAlpha = alpha * rimGlow * 0.7;
			ctx.strokeStyle = "rgba(255, 232, 180, 0.85)";
			ctx.lineWidth = 10;
			traceOrganic();
			ctx.stroke();
			ctx.restore();
		}
	}

	ctx.restore();
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
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

/** Creates the WebGL GPU shader renderer for a canvas, with seamless Canvas 2D fallback. */
export function createArcShaderRenderer(canvas: HTMLCanvasElement): ArcShaderRenderer {
	const gl =
		canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false }) ??
		(canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);

	if (gl !== null) {
		const vs = compileShader(gl, gl.VERTEX_SHADER, ARC_VERTEX_SHADER);
		const fs = compileShader(gl, gl.FRAGMENT_SHADER, ARC_FRAGMENT_SHADER);
		const program = vs !== null && fs !== null ? gl.createProgram() : null;
		if (vs !== null && fs !== null && program !== null) {
			gl.attachShader(program, vs);
			gl.attachShader(program, fs);
			gl.linkProgram(program);
			if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
				const buffer = gl.createBuffer();
				gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
				gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

				const posLoc = gl.getAttribLocation(program, "a_pos");
				const loc = {
					res: gl.getUniformLocation(program, "u_res"),
					time: gl.getUniformLocation(program, "u_time"),
					alpha: gl.getUniformLocation(program, "u_alpha"),
					darkness: gl.getUniformLocation(program, "u_darkness"),
					orbRadius: gl.getUniformLocation(program, "u_orbRadius"),
					orbIntensity: gl.getUniformLocation(program, "u_orbIntensity"),
					melt: gl.getUniformLocation(program, "u_melt"),
					rimGlow: gl.getUniformLocation(program, "u_rimGlow"),
					prismShift: gl.getUniformLocation(program, "u_prismShift"),
				};

				return {
					backend: "webgl",
					render(width, height, dpr, state, timeSec) {
						const targetW = Math.max(1, Math.round(width * dpr));
						const targetH = Math.max(1, Math.round(height * dpr));
						if (canvas.width !== targetW || canvas.height !== targetH) {
							canvas.width = targetW;
							canvas.height = targetH;
						}
						gl.viewport(0, 0, targetW, targetH);
						gl.clearColor(0, 0, 0, 0);
						gl.clear(gl.COLOR_BUFFER_BIT);
						if (state.shader.alpha <= 0.001) return;

						gl.useProgram(program);
						gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
						gl.enableVertexAttribArray(posLoc);
						gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

						gl.uniform2f(loc.res, targetW, targetH);
						gl.uniform1f(loc.time, timeSec);
						gl.uniform1f(loc.alpha, state.shader.alpha);
						gl.uniform1f(loc.darkness, state.shader.darkness);
						gl.uniform1f(loc.orbRadius, state.shader.orbRadius);
						gl.uniform1f(loc.orbIntensity, state.shader.orbIntensity);
						gl.uniform1f(loc.melt, state.shader.meltProgress);
						gl.uniform1f(loc.rimGlow, state.shader.rimGlow);
						gl.uniform1f(loc.prismShift, state.shader.prismShift);

						gl.drawArrays(gl.TRIANGLES, 0, 6);
					},
					dispose() {
						if (buffer !== null) gl.deleteBuffer(buffer);
						gl.deleteProgram(program);
						gl.deleteShader(vs);
						gl.deleteShader(fs);
					},
				};
			}
			gl.deleteProgram(program);
		}
		if (vs !== null) gl.deleteShader(vs);
		if (fs !== null) gl.deleteShader(fs);
	}

	const ctx2d = canvas.getContext("2d");
	return {
		backend: "canvas2d",
		render(width, height, dpr, state, timeSec) {
			if (ctx2d === null) return;
			const targetW = Math.max(1, Math.round(width * dpr));
			const targetH = Math.max(1, Math.round(height * dpr));
			if (canvas.width !== targetW || canvas.height !== targetH) {
				canvas.width = targetW;
				canvas.height = targetH;
			}
			ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
			drawFallbackReveal(ctx2d, width, height, state, timeSec);
		},
		dispose() {
			// Nothing to free for Canvas 2D
		},
	};
}
