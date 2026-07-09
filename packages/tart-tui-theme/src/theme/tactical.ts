import type { Theme } from './types.ts'

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
 * vignette, a rolling bar, and denser scanlines — an unstable signal, *not*
 * spliced color layers. `glitch.chromaticAberration` is therefore held at 0.
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

	// B3: critical only. Neon red — locks, failures, destructive edges.
	red: '#FF2A1F',
	rust: '#7A0E08',

	// Text hierarchy, all amber-tinted so body copy stays inside the warm world.
	sand: '#E0A040',
	umber: '#7A4A10',
	soot: '#3A2408',
} as const

export const tactical: Theme = {
	id: 'tactical',
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

		// B-contrast: no laser purple in this world. "Injected" processes read as
		// bright yellow — the same amber system, just running hot.
		inject: palette.yellow,
		injectDim: palette.burnt,

		// B3: neon red, held in reserve for critical info and warnings.
		alert: palette.red,
		alertDim: palette.rust,

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

	reticle: {
		// B8/B9: concentric segmented dials spinning slowly and mechanically, at
		// different speeds in opposing directions (signs alternate: + / - / +).
		// "Slow, mechanical, constant" — magnitudes stay well under AUGMENTED's.
		//
		// Two defences against the 2:1-cell "bar" (a lit arc on 12/6 o'clock smears
		// into a flat `──────` run): low duty keeps every lit arc short, and a static
		// `phase = π/2 − wedge·(1+duty)/2` parks each ring's gaps on the cardinals so
		// the top and bottom fall open. B10 holographic depth comes from each ring's
		// `depth` plane (foreground / mid / far). Verified at 60x30 and 32x18.
		rings: [
			// 6-segment graduated targeting ring with inward ticks. Foreground (depth 0)
			// so the dominant amber reads full-bright; gaps parked on the cardinals.
			{ radius: 9, color: palette.amber, speed: 0.18, segments: 6, duty: 0.4, ticks: true, phase: 0.84, depth: 0 },
			// A far pair of burnt side-brackets (depth 1 → DIM + 0.45 alpha): 2 arcs at
			// 42% duty, phase-parked so the lit arcs sit on the left/right and the top
			// and bottom stay open — never a bar. The far plane for holographic depth (B10).
			{ radius: 6.6, color: palette.burnt, speed: -0.45, segments: 2, duty: 0.42, phase: -0.66, depth: 1 },
			// Inner dial: bright yellow, the hottest ring, turning fastest. Mid plane
			// (depth 0.5) so it floats between the amber frame and the far brackets. Six
			// shorter arcs, gaps parked on the cardinals — reads as a spinning dial.
			{ radius: 4.4, color: palette.yellow, speed: 0.85, segments: 6, duty: 0.46, phase: 0.81, depth: 0.5 },
		],
		crosshair: palette.yellow,
		crosshairSpan: 2,
		// B8: bracketed targeting box. B3: the lock is the reticle's one red voice.
		lock: palette.red,
		// "Slow, mechanical, constant." The lock breathes slowly (tempo 1.0 rad/s,
		// ~1/3 of AUGMENTED's) with a small, steady travel — never snappy.
		lockPulse: { tempo: 1.0, amplitude: 0.5, gap: 0.8 },
		// A warm sweep head orbiting the rim — the radar/optic sweep (AUGMENTED's is
		// laser violet). Slow, with a slightly longer smear to match the constant motion.
		sweep: { color: palette.amber, speed: 0.55, trail: 4, rim: 0.4, arc: 0.08, arcGain: 0.03 },
	},

	fx: {
		// B5: elements emit light — but subtler than AUGMENTED (higher threshold,
		// lower strength), because here the dominant artifact is the CRT itself.
		bloom: { threshold: 0.6, strength: 0.22, radius: 2 },
		// B13: heavier scanlines than AUGMENTED. `applyScanlines` multiplies RGB by
		// `strength` on every `step`-th row, so lower strength = darker lines and a
		// smaller step = denser lines. AUGMENTED is 0.94 / step 3; this is darker and
		// twice as dense.
		scanlines: { strength: 0.8, step: 2 },
		// B13: the "looking through optics" tunnel. AUGMENTED has no vignette at all.
		vignette: 0.7,
		// B12/B13: a slow rolling bar — the signature "slightly unstable signal".
		crtBar: { speed: 0.35, height: 0.1, intensity: 0.5, fadeDistance: 0.25 },
		glitch: {
			// B12: occasional, short, small bursts — an unstable signal, not chaos.
			// Rarer and gentler than AUGMENTED (0.55 / 3 lines / shift 9).
			chancePerSecond: 0.3,
			maxLines: 2,
			maxShift: 5,
			shiftFlipRatio: 0.8,
			colorGlitchChance: 0.15,
			minDuration: 0.04,
			maxDuration: 0.1,
			// B13, the sharpest differentiator from AUGMENTED: NO color separation.
			// This signal is unstable, not spliced. Do not raise above 0.
			chromaticAberration: 0,
		},
	},

	// B-contrast / typography: a plain typewriter-terminal spinner (AUGMENTED uses
	// rounded quadrant arcs).
	spinner: ['|', '/', '-', '\\'],
	// B7/B11: narrow, unambiguous-width codepoints only (ASCII + basic symbols) so
	// the cascading readout never tears the terminal grid.
	streamChars: '0123456789ABCDEF.:_-=+*#%',
	barRamp: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
}
