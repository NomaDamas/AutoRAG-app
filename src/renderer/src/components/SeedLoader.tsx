import type { CSSProperties, ReactElement } from "react";

/**
 * The answer loader: a tiny sunflower seed head (Vogel's model, seed n at n golden angles and radius ∝ √n) whose seeds
 * brighten in turn from the centre outward. It stands beside the "thinking" line in AI Search and the inspector chat.
 * Styles live in `styles/base.css` (`.seed-loader`); reduced motion holds it still.
 */

const SEED_COUNT = 21;
const VIEW = 14;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** How long the wave takes to run from the innermost seed to the outermost. */
const WAVE_SPREAD_MS = 700;

interface Seed {
	readonly x: number;
	readonly y: number;
	readonly delayMs: number;
}

const SEEDS: readonly Seed[] = (() => {
	const spacing = (VIEW / 2 - 1) / Math.sqrt(SEED_COUNT);
	const seeds: Seed[] = [];
	for (let n = 0; n < SEED_COUNT; n += 1) {
		const radius = spacing * Math.sqrt(n + 0.5);
		seeds.push({
			x: Math.round((VIEW / 2 + Math.cos(n * GOLDEN) * radius) * 100) / 100,
			y: Math.round((VIEW / 2 + Math.sin(n * GOLDEN) * radius) * 100) / 100,
			delayMs: Math.round((Math.sqrt(n) / Math.sqrt(SEED_COUNT - 1)) * WAVE_SPREAD_MS),
		});
	}
	return seeds;
})();

export function SeedLoader({ size = 14 }: { readonly size?: number }): ReactElement {
	return (
		<svg className="seed-loader" width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden="true" focusable="false">
			{SEEDS.map((seed, index) => (
				<circle key={index} cx={seed.x} cy={seed.y} r={0.95} style={{ "--seed-delay": `${seed.delayMs}ms` } as CSSProperties} />
			))}
		</svg>
	);
}
