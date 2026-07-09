import type { Theme } from './types'

/**
 * AUGMENTED CYBERPUNK HUD — amber + neon.
 *
 * "An older, robust military-grade system (the amber) has been heavily modified,
 * hacked, or augmented with cutting-edge, experimental cybernetics (the neon)."
 * Amber carries the structure; electric teal is cool relief on borders, labels
 * and structural data; laser purple marks anything "injected" (merged records,
 * `#123` cross-references, count badges, bullets); piercing red is reserved —
 * sparingly — for failures and destructive edges. Everything sits on a
 * pitch-black void and supplies its own light.
 *
 * Chaotic, dense, spectacular.
 */
const palette = {
	black: '#000000',
	// Foundation — "glowing amber, golden yellow, and burnt orange." These handle
	// the structural baseline. Amber and gold are bright enough to cross the
	// glow threshold; burnt orange stays under it so headings read crisp.
	amber: '#FFA31A', // core        lum ~0.69 — glows
	gold: '#FFD447', // coreBright   lum ~0.82 — glows
	burnt: '#A34A00', // coreDim     lum ~0.36 — crisp (headings)
	amberEmber: '#2A1A0C', // raised — a warm ember behind the selected row, never a cool fill
	// Augmentation — "Electric Teal: a sharp, cool contrast to the amber." The
	// electric grid teal is for live data (glows); the deep teal is the recessive
	// structural teal used on borders and dim grids (stays under the glow gate, so the cool
	// frame reads clearly but recedes behind the amber content, per the brief's
	// "push the cooler teal … to the background").
	teal: '#12E5C8', // grid         lum ~0.64 — glows (labels, inline code, branch refs)
	tealDeep: '#0A7E6E', // gridDim + border  lum ~0.35 — crisp, recessive teal
	// Augmentation — "Laser Purple (Magenta/Violet): used for 'injected' or highly
	// advanced processes." Bright enough to cross the glow threshold.
	purple: '#B14CFF', // inject     lum ~0.50 — glows
	// Critical — "Piercing Laser Red." Brightened from a deep crimson so the laser
	// actually *glows* (a deep red sits below the threshold and would read as a dull
	// dot). Reserved for failures and destructive edges, so it stays rare.
	red: '#FF3344', // alert         lum ~0.45 — glows
	// Text hierarchy, amber-tinted. Scanlines only darken the *background* buffer,
	// so legibility here is purely foreground-on-black: bone is bright, umber is a
	// readable dim, ash is faint scaffolding (lifted a touch from pure shadow).
	bone: '#E8B563', // text         lum ~0.73
	umber: '#8A5A12', // textDim     lum ~0.38 — under the glow gate, so body text stays crisp
	ash: '#4A2F0E', // textFaint     lum ~0.20 — faint but legible
} as const

export const augmented: Theme = {
	name: 'AUGMENTED',
	tagline: 'AMBER SUBSTRATE // NEON GRAFT',

	color: {
		// "Backgrounds: Absolute black. The UI elements must supply 100% of the light."
		void: palette.black,
		panel: 'transparent', // the void shows through every panel
		raised: palette.amberEmber, // selected row reads as a warm ember, not a cool band

		// "The Foundation … primary dials, base wireframes, and standard readouts."
		core: palette.amber,
		coreBright: palette.gold,
		coreDim: palette.burnt,

		// "Electric Teal … secondary structural grids, bounding boxes … environmental
		// scans or network pings." Lands on coordinates, inline code, branch refs.
		grid: palette.teal,
		gridDim: palette.tealDeep,

		// "Laser Purple … used for 'injected' or highly advanced processes." Lands on
		// merged records, `#123` cross-references, tab counts, and body bullets.
		inject: palette.purple,

		// "Piercing Laser Red. Reserved exclusively for extreme contrast." Used sparingly:
		// the selection caret, the CLOSED state, the branch arrow, a spent rate limit.
		alert: palette.red,

		text: palette.bone,
		textDim: palette.umber,
		textFaint: palette.ash,
	},

	chrome: {
		// "single" frame is the AUGMENTED tell (tactical goes "heavy"); the teal
		// frame is the "cool relief" the brief asks for against the amber structure.
		frameStyle: 'single',
		panelStyle: 'single',
		// "Use teal for borders …" — the recessive deep teal: unmistakably a teal
		// frame (the tell against tactical's burnt-orange "heavy" frame) but dim
		// enough to stay under the glow gate and recede behind the amber it wraps.
		border: palette.tealDeep,
		title: palette.amber,
		heading: '// ', // "frequent use of brackets [ ], slashes //, and underscores _"
	},

	semantic: {
		// Color dictates the classification. No green anywhere.
		//   OPEN   — "Amber: standard system logs and baseline metrics." The live
		//            baseline record is amber; this keeps teal reserved for structure.
		//   MERGED — the injected graft, a branch spliced into the amber system: purple.
		//   CLOSED — a terminated/failed record: red (and rare — ~1 per tab in the feed).
		//   DRAFT  — a not-yet-active baseline: dim amber.
		open: palette.amber,
		merged: palette.purple,
		closed: palette.red,
		draft: palette.umber,
	},

	fx: {
		// "Heavy use of bloom (outer glow) on all elements … intensely bright
		// optical lasers and glowing gas tubes overlapping in dark space." Read by
		// the glyph-aware GlowEffect: only real glyphs emit, and the glow lands on
		// the BACKGROUND of neighbours (tinted toward the glyph's colour), so amber
		// stays amber and the void stays black. The low threshold is what carries the
		// "heavy" — every neon crosses it and glows: amber (0.69), gold (0.82), teal
		// (0.64), and crucially the purple (0.50) and red (0.45) *lasers*, which a
		// higher gate would extinguish. The dim tiers, the teal border, and burnt
		// headings sit just under it and stay crisp. Strength is deliberately modest:
		// glow is meant to halo the hottest glyphs (background luminance p99 ≈ 0.46),
		// not light the field — the median cell stays at 0.02 and the void reads black.
		// Pushing strength past ~0.15 washes a quarter of the screen and the palette
		// stops being legible. Radius is pinned at 2: the kernel is O(w·h·r²), and it
		// spans `r * CELL_ASPECT` cells horizontally so the halo is round on screen.
		glow: { threshold: 0.4, strength: 0.1, radius: 2 },
		// Scanlines only darken the background buffer, which is a transparent void
		// here, so they read as a faint texture over the glow halo — deliberately
		// lighter/sparser than tactical's CRT (this theme's signature is the glow,
		// not the tube). No vignette, no rolling CRT bar: those belong to tactical.
		scanlines: { strength: 0.92, step: 3 },
		glitch: {
			// "The animation should feel fast, mechanical, and occasionally unstable."
			// ~1 burst every couple of seconds — occasional, not constant static.
			chancePerSecond: 0.5,
			maxLines: 3,
			maxShift: 8,
			// Favour horizontal misalignment (shift) over datamosh color-smear, since
			// the brief's move is layers sliding sideways and snapping back.
			shiftFlipRatio: 0.7,
			colorGlitchChance: 0.3,
			// A split second, then it snaps back.
			minDuration: 0.05,
			maxDuration: 0.14,
			// The signature move: "a sudden system shock might cause the amber, teal,
			// and purple layers … to misalign horizontally for a split second
			// (chromatic aberration) before snapping back." Gated to fire *only* during
			// a burst (see GlitchDirector), strongest at the edges, zero at the center.
			//
			// This is where essentially all of the glitch's punch lives: the row tearing
			// alone disturbs ~2% of the screen's glyphs, the aberration ~26%. A spliced
			// system loses register between its color layers.
			chromaticAberration: 3,
			chromaDropout: 0,
		},
	},

	barRamp: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
	sparkRamp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
}
