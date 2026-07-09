import type { Theme } from './types'

/**
 * TACTICAL RETRO HUD — amber lens.
 *
 * Classic cyberpunk optics: looking through the lens of a cyborg or a
 * surveillance rig. Serious, gritty, analytical. Per the brief, amber, burnt
 * orange, and bright yellow *dominate the interface*; neon red is the only loud
 * voice (critical info / warnings); cyan appears only as a brief, rare flash.
 *
 * This is a *lens*, not a graft (contrast AUGMENTED): the whole screen is one
 * warm phosphor, and the signature effect is heavier CRT artifacting —
 * vignette, a rolling bar, denser scanlines, and glitch bursts that make the tube
 * lose chroma sync rather than pull its color layers apart. So
 * `glitch.chromaticAberration` is held at 0 and `glitch.chromaDropout` carries the
 * corruption: an unstable analog signal, not a splice.
 */
const palette = {
	// B1: "Deep, crushing blacks ... and muted, murky greens or browns." Not the
	// absolute #000000 of AUGMENTED — a warm brown-black, like a dirty optic. The
	// panels sit a clear step above the void so data reads as floating over depth.
	void: '#0D0A04',
	panel: '#191108',
	raised: '#30200C',

	// B2: the foundation. Amber / burnt orange / bright yellow. Pushed a shade more
	// orange than AUGMENTED's golden amber, so the two themes diverge at a glance.
	amber: '#FF9500',
	yellow: '#FFC61A',
	burnt: '#A34F00',

	// Structural readouts (coordinates, refs, repo, code). AUGMENTED renders these
	// in cool teal; TACTICAL keeps them *warm* — an amber-gold — because in this
	// world cyan is not a working color, only a rare flash (see `cyan`).
	gold: '#EAA62B',
	goldDim: '#7E5518',

	// B4: the rare cold flash. Used on exactly one surface (a MERGED record).
	cyan: '#26C9BE',

	// B3: critical only. Neon red — failures, warnings, destructive edges.
	red: '#FF2A1F',

	// Text hierarchy, all amber-tinted so body copy stays inside the warm world.
	sand: '#E0A040',
	umber: '#7A4A10',
	soot: '#3A2408',
} as const

export const tactical: Theme = {
	name: 'TACTICAL',
	tagline: 'OPTIC FEED // NOMINAL',

	color: {
		// B1: murky brown-black void; panels a distinct murky surface above it.
		void: palette.void,
		panel: palette.panel,
		raised: palette.raised,

		// B2: amber owns the structure; bright yellow is the hot highlight; burnt
		// orange is the dim structural tone.
		core: palette.amber,
		coreBright: palette.yellow,
		coreDim: palette.burnt,

		// "grid" is the structural-data slot (coords, repo, refs, inline code). Kept
		// warm on purpose: routing it through cyan — as AUGMENTED does — would put
		// cold light on every screen and break B4 ("brief flashes ... rare"). Here
		// the only cyan in the whole UI is `semantic.merged`.
		grid: palette.gold,
		gridDim: palette.goldDim,

		// B-contrast: no laser purple in this world. "Injected" values read as bright
		// yellow — the same amber system, just running hot.
		inject: palette.yellow,

		// B3: neon red, held in reserve for critical info and warnings.
		alert: palette.red,

		text: palette.sand,
		textDim: palette.umber,
		textFaint: palette.soot,
	},

	chrome: {
		// B-contrast: chunky, military-grade framing (AUGMENTED uses `single`), and a
		// bracket heading prefix (AUGMENTED uses `// `). Warm burnt-orange borders —
		// never the cool teal of the other theme.
		frameStyle: 'heavy',
		panelStyle: 'single',
		border: palette.burnt,
		title: palette.amber,
		heading: '[ ',
	},

	semantic: {
		// A warm-first ladder: amber = nominal, red = terminated/critical, dim umber
		// = inactive. MERGED is the single, rare cyan flash the brief calls for.
		open: palette.amber,
		closed: palette.red,
		merged: palette.cyan,
		draft: palette.umber,
	},

	fx: {
		// B5: elements emit light — but subtler than AUGMENTED, because here the
		// dominant artifact is the CRT itself. Read by the glyph-aware GlowEffect
		// (only glyphs emit; the glow tints neighbour BACKGROUNDS toward the glyph
		// colour, never the void). The high threshold admits only the dominant warm
		// tones — amber (0.64), gold (0.68), yellow (0.77), sand text (0.66) — so
		// the lens emits from its amber structure while red, the rare cyan, and the
		// dim tiers stay crisp. Low strength keeps it a gentle emission (background
		// luminance p99 ≈ 0.13 against AUGMENTED's 0.46, and it adds nothing to the
		// murky-void median) that supports the vignette + rolling bar + heavy
		// scanlines rather than fighting them. Radius pinned at 2.
		glow: { threshold: 0.6, strength: 0.07, radius: 2 },
		// B13: heavier scanlines than AUGMENTED. `applyScanlines` multiplies RGB by
		// `strength` on every `step`-th row, so lower strength = darker lines and a
		// smaller step = denser lines. AUGMENTED is 0.92 / step 3; this is darker and
		// twice as dense.
		scanlines: { strength: 0.8, step: 2 },
		// B13: the "looking through optics" tunnel. AUGMENTED has no vignette at all.
		vignette: 0.7,
		// B12/B13: a slow rolling bar — the signature "slightly unstable signal", and
		// TACTICAL's only *continuous* motion; the glitch is punctuation, not a pulse.
		//
		// `speed` is in **rows per second**, not a normalized fraction: the effect
		// advances `position += (deltaMs/1000) * speed` and wraps at
		// `cycleHeight = height * (1 + 2*barHeight)`. So the sweep period is
		// `cycleHeight / speed` seconds — at `speed: 6` that is ~9s over a 44-row
		// terminal. A value like 0.35 reads as "slow" but means one sweep every two
		// and a half minutes, i.e. a bar that never visibly moves.
		crtBar: { speed: 6, height: 0.1, intensity: 0.5, fadeDistance: 0.25 },
		glitch: {
			// B12: "elements sometimes flicker … or exhibit slight glitch artifacts,
			// suggesting a complex, perhaps slightly unstable, electronic signal."
			// Bursts land about as often as AUGMENTED's and tear a comparable number of
			// rows — the two themes differ in *how the color fails*, not in how often.
			chancePerSecond: 0.45,
			maxLines: 3,
			maxShift: 10,
			shiftFlipRatio: 0.75,
			// Datamosh streaks are more of this theme's language than AUGMENTED's, since
			// it has no channel split to carry the color corruption.
			colorGlitchChance: 0.4,
			minDuration: 0.05,
			maxDuration: 0.16,

			// B13, the sharpest differentiator from AUGMENTED: **no color separation.**
			// An RGB channel split would fringe this all-warm palette with cool colors
			// and make it read as a splice. Do not raise above 0.
			chromaticAberration: 0,
			// Instead, the analog failure: the tube loses chroma sync and the whole frame
			// washes toward raw luma for two to four frames, then snaps back. It disturbs
			// the same share of the screen as AUGMENTED's aberration (~26%), so the two
			// glitches carry equal weight — but this one invents no hues, it removes them.
			chromaDropout: 0.6,
		},
	},

	barRamp: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
	sparkRamp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
}
