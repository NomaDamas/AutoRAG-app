/**
 * The Ready → Finder reveal's light, shared by the two places that draw it:
 * the Dazzi window (the renderer's reveal canvas) and the borderless desktop windows that cover every display
 * behind it (`src/main/reveal-backdrop.ts`). Both run the same fragment shader in screen coordinates and receive the
 * same per-frame values from the renderer's clock, so the light continues across the window's edge without a seam.
 *
 * What it draws (design: design-mockups/onboarding-intro-desktop-v3-fullscreen.html):
 * - a dusk layer that dims the desktop;
 * - a flowing field of sunflower yellow, cream and sky blue that breathes outward from behind the Dazzi mark and
 *   spreads until it covers the desktop;
 * - a warm glow right behind the mark;
 * - at the end, the Finder window rising through it: the light parts exactly along the window's outline, and the
 *   window reads as a clear pane of glass (the light seen through it, magnified) until it clears to Finder.
 */

/** Values the renderer computes each frame from the reveal clock (see `computeRevealState`). */
export interface RevealLightFrame {
	/** Seconds on the reveal clock; drives the flow of the field. */
	readonly time: number;
	/** Dusk layer strength `[0..1]`, scaled by each surface's own maximum. */
	readonly dusk: number;
	/** The light's overall strength `[0..1]`. */
	readonly light: number;
	/** How far the light has spread from the mark `[0..1]` (1 covers the whole desktop). */
	readonly spread: number;
	/** The warm glow behind the mark `[0..1]`. */
	readonly glow: number;
	/** The Finder window's rise `[0..1]`: it starts 22 px low at 95.5 % and settles in place. */
	readonly rise: number;
	/** `1` once the window's outline has opened in the light (`0` before). */
	readonly open: number;
}

export const REVEAL_LIGHT_IDLE: RevealLightFrame = { time: 0, dusk: 0, light: 0, spread: 0, glow: 0, rise: 0, open: 0 };

/** Where a surface sits on screen and where the Dazzi window is, all in CSS pixels in screen space. */
export interface RevealLightScene {
	/** Top-left of this surface on screen. */
	readonly originX: number;
	readonly originY: number;
	/** The Dazzi window's content box on screen. */
	readonly windowX: number;
	readonly windowY: number;
	readonly windowWidth: number;
	readonly windowHeight: number;
	/** Length of one field unit: the height of the display the Dazzi window is on. */
	readonly unit: number;
	/** The strongest the dusk gets on this surface: the window draws it opaque, the desktop leaves a hint of itself. */
	readonly duskMax: number;
}

export const REVEAL_LIGHT_VERTEX = `
attribute vec2 a_pos;
void main() {
	gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const REVEAL_LIGHT_FRAGMENT = `
precision highp float;

uniform vec2 u_res;       // drawing buffer size (device px)
uniform float u_dpr;      // device px per CSS px
uniform vec2 u_origin;    // this surface's top-left on screen (CSS px)
uniform vec4 u_window;    // Dazzi window content box on screen: x, y, width, height (CSS px)
uniform float u_unit;     // one field unit (CSS px)
uniform float u_duskMax;
uniform float u_time;
uniform float u_dusk;
uniform float u_light;
uniform float u_spread;
uniform float u_glow;
uniform float u_rise;
uniform float u_open;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
	float v = 0.0, a = 0.5;
	mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
	for (int i = 0; i < 3; i++) { v += a * noise(p); p = m * p * 2.02 + 0.13; a *= 0.5; }
	return v;
}
float sdRoundBox(vec2 q, vec2 b, float r) {
	vec2 d = abs(q) - b + r;
	return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

void main() {
	// Screen position of this fragment (CSS px, y down), then field coordinates around the window's centre (y up).
	vec2 css = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_dpr;
	vec2 screenPos = u_origin + css;
	vec2 centre = u_window.xy + u_window.zw * 0.5;
	vec2 pc = (screenPos - centre) / u_unit * vec2(1.0, -1.0);
	vec2 halfWin = u_window.zw * 0.5 / u_unit;

	// The window's outline as it rises (22 px low at 95.5 %, settling in place), and whether we are inside it.
	float ws = 0.955 + 0.045 * u_rise;
	vec2 wc = vec2(0.0, -(22.0 / u_unit) * (1.0 - u_rise));
	float wd = sdRoundBox(pc - wc, halfWin * ws, (12.0 / u_unit) * ws);
	float inside = (1.0 - smoothstep(-0.0012, 0.0012, wd)) * step(0.5, u_open);

	float t = u_time * 0.7;
	vec2 p = pc * 0.75 / 0.62;
	// The light next to the rising window is pushed aside, the way water parts.
	vec2 outward = length(pc) > 0.0001 ? normalize(pc) : vec2(0.0);
	p += outward * (0.75 / 0.62) * 0.16 * sin(3.14159 * u_rise) * exp(-max(wd, 0.0) * 9.0) * step(0.5, u_open);
	// Through the window's glass the light is magnified and nudged.
	p = mix(p, p * 0.74 + vec2(0.0, 0.02), inside);
	// Breath: rings of light swell outward from behind the mark.
	float rE = length(pc);
	p *= 1.0 + 0.12 * sin(rE * 7.5 - t * 1.6) * exp(-rE * 1.2) + 0.04 * sin(rE * 3.0 - t * 0.7);

	vec2 q = vec2(fbm(p + vec2(0.0, 0.11 * t)), fbm(p + vec2(5.2, 1.3) - vec2(0.09 * t, 0.0)));
	vec2 r = vec2(fbm(p + 1.6 * q + vec2(1.7, 9.2) + 0.15 * t), fbm(p + 1.6 * q + vec2(8.3, 2.8) - 0.12 * t));
	float f = fbm(p + 1.6 * r);

	vec3 cream = vec3(1.00, 0.96, 0.84);
	vec3 butter = vec3(1.00, 0.90, 0.58);
	vec3 sunflower = vec3(1.00, 0.74, 0.16);
	vec3 amber = vec3(1.00, 0.66, 0.22);
	vec3 peach = vec3(1.00, 0.84, 0.66);
	vec3 sky = vec3(0.34, 0.63, 1.00);
	vec3 skyPale = vec3(0.55, 0.78, 1.00);

	float fn = clamp((f - 0.18) * 3.2, 0.0, 1.0);
	float qn = clamp((length(q) - 0.45) * 2.4, 0.0, 1.0);
	vec3 col = mix(cream, butter, smoothstep(0.0, 0.45, fn));
	col = mix(col, sunflower, smoothstep(0.45, 0.9, fn) * 0.8);
	col = mix(col, amber, smoothstep(0.6, 1.0, qn) * 0.42);
	col = mix(col, peach, smoothstep(0.7, 1.0, clamp((r.x - 0.45) * 2.5, 0.0, 1.0)) * 0.35);
	// Sky blue pools only where the yellow is thin, so the two never mix into green.
	float sn = clamp((fbm(p * 0.9 + 1.4 * r + vec2(3.1, -2.4) - 0.07 * t) - 0.28) * 3.0, 0.0, 1.0);
	float skyW = smoothstep(0.15, 0.7, sn) * (1.0 - smoothstep(0.55, 0.95, fn));
	col = mix(col, mix(skyPale, sky, smoothstep(0.55, 1.0, sn)), skyW * 0.8);
	// A broad white sheen and two slow white flares.
	float band = pow(1.0 - clamp(abs(f - 0.5) * 2.2, 0.0, 1.0), 3.0);
	col = mix(col, vec3(1.0), band * 0.5);
	vec2 s1 = vec2(0.32 * sin(t * 0.21), 0.18 * cos(t * 0.17)) * vec2(1.6, 1.0);
	vec2 s2 = vec2(0.45 * cos(t * 0.13 + 2.0), 0.25 * sin(t * 0.19 + 1.0)) * vec2(1.6, 1.0);
	col = mix(col, vec3(1.0), clamp(0.8 * exp(-dot(pc - s1, pc - s1) * 6.0) + 0.6 * exp(-dot(pc - s2, pc - s2) * 9.0), 0.0, 1.0));
	// The warm glow behind the mark: a white core and a sunflower halo.
	float rr = length(pc);
	col = mix(col, vec3(1.0, 0.99, 0.94), clamp(u_glow * exp(-rr * rr * 160.0), 0.0, 1.0));
	col = mix(col, vec3(1.0, 0.86, 0.45), clamp(u_glow * 0.45 * exp(-rr * rr * 18.0), 0.0, 1.0));

	// The light spreads from the mark until it covers the desktop.
	float s = u_spread * u_spread * (3.0 - 2.0 * u_spread);
	float reach = mix(0.10, 1.25, s);
	float mask = smoothstep(reach * (1.0 + 0.04 * sin(t * 1.1)), reach * 0.4, rr + 0.30 * (f - 0.5) + 0.10 * (r.y - 0.5));
	mask = mix(mask, 1.0, smoothstep(0.85, 1.0, u_spread));
	float a = u_light * mask;

	// Inside the window: a clear pane of glass that lets the light through at half strength, brighter and cooler,
	// then clears to Finder; a single 1 px highlight on its edge while it is still glass. No dusk behind the glass.
	float glass = 0.5 * (1.0 - smoothstep(0.55, 1.0, u_rise));
	col = mix(col, mix(col, vec3(0.97, 0.985, 1.0), 0.35), inside);
	a = mix(a, a * glass, inside);
	float edge = exp(-wd * wd / 0.0000035) * (1.0 - smoothstep(0.6, 1.0, u_rise)) * step(0.5, u_open);
	col = mix(col, vec3(1.0), clamp(edge, 0.0, 1.0));
	a = max(a, 0.85 * edge * u_light);

	// Light over dusk, premultiplied.
	float duskA = u_dusk * u_duskMax * (1.0 - inside);
	vec3 duskCol = vec3(0.024, 0.027, 0.05);
	vec3 rgb = col * a + duskCol * duskA * (1.0 - a);
	float outA = a + duskA * (1.0 - a);
	gl_FragColor = vec4(rgb, outA);
}
`;

/**
 * The page each desktop window loads: a full-window canvas running {@link REVEAL_LIGHT_FRAGMENT}, drawn whenever the
 * main process calls `window.__revealFrame(frame)` with the renderer's values. Self-contained (no preload, no network).
 */
export function revealBackdropPageHtml(scene: RevealLightScene): string {
	const sceneJson = JSON.stringify(scene);
	return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100vw;height:100vh}
</style></head><body><canvas id="c"></canvas><script>
(function(){
var scene=${sceneJson};
var VS=${JSON.stringify(REVEAL_LIGHT_VERTEX)};
var FS=${JSON.stringify(REVEAL_LIGHT_FRAGMENT)};
var c=document.getElementById("c");
var gl=c.getContext("webgl",{alpha:true,premultipliedAlpha:true,antialias:false});
if(!gl){window.__revealFrame=function(){};return;}
function sh(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);return s;}
var prog=gl.createProgram();gl.attachShader(prog,sh(gl.VERTEX_SHADER,VS));gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,FS));gl.linkProgram(prog);
if(!gl.getProgramParameter(prog,gl.LINK_STATUS)){window.__revealFrame=function(){};return;}
var buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
var pos=gl.getAttribLocation(prog,"a_pos");
var names=["u_res","u_dpr","u_origin","u_window","u_unit","u_duskMax","u_time","u_dusk","u_light","u_spread","u_glow","u_rise","u_open"];
var loc={};names.forEach(function(n){loc[n]=gl.getUniformLocation(prog,n);});
window.__revealFrame=function(f){
var dpr=Math.min(1,window.devicePixelRatio||1);var w=Math.max(1,Math.round(innerWidth*dpr)),h=Math.max(1,Math.round(innerHeight*dpr));
if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
gl.useProgram(prog);gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
gl.uniform2f(loc.u_res,w,h);gl.uniform1f(loc.u_dpr,dpr);gl.uniform2f(loc.u_origin,scene.originX,scene.originY);
gl.uniform4f(loc.u_window,scene.windowX,scene.windowY,scene.windowWidth,scene.windowHeight);
gl.uniform1f(loc.u_unit,scene.unit);gl.uniform1f(loc.u_duskMax,scene.duskMax);
gl.uniform1f(loc.u_time,f.time);gl.uniform1f(loc.u_dusk,f.dusk);gl.uniform1f(loc.u_light,f.light);gl.uniform1f(loc.u_spread,f.spread);
gl.uniform1f(loc.u_glow,f.glow);gl.uniform1f(loc.u_rise,f.rise);gl.uniform1f(loc.u_open,f.open);
gl.drawArrays(gl.TRIANGLES,0,6);
};
window.__revealFrame({time:0,dusk:0,light:0,spread:0,glow:0,rise:0,open:0});
})();
</script></body></html>`;
}

/** Narrows an IPC payload to a {@link RevealLightFrame} with finite numbers. */
export function isRevealLightFrame(value: unknown): value is RevealLightFrame {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return ["time", "dusk", "light", "spread", "glow", "rise", "open"].every((key) => typeof v[key] === "number" && Number.isFinite(v[key]));
}
