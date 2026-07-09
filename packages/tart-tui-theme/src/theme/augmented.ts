import type { Theme } from './types.ts'

/**
 * AUGMENTED CYBERPUNK HUD — amber + neon.
 *
 * "An older, robust military-grade system (the amber) has been heavily modified,
 * hacked, or augmented with cutting-edge, experimental cybernetics (the neon)."
 * Amber carries the structure; electric teal is cool relief on borders and
 * coordinates; laser purple marks anything "injected" (spinners, progress,
 * decryption, holographic rings); piercing red is reserved — sparingly — for
 * target locks and failures. Everything sits on a pitch-black void and supplies
 * its own light.
 *
 * Chaotic, dense, spectacular.
 */
const palette = {
	black: '#000000',
	// Foundation — "glowing amber, golden yellow, and burnt orange." These handle
	// the structural baseline. Amber and gold are bright enough to cross the bloom
	// threshold and glow; burnt orange stays under it so headings read crisp.
	amber: '#FFA31A', // core        lum ~0.69 — glows
	gold: '#FFD447', // coreBright   lum ~0.82 — glows
	burnt: '#A34A00', // coreDim     lum ~0.36 — crisp (headings)
	amberEmber: '#2A1A0C', // raised — a warm ember behind the selected row, never a cool fill
	// Augmentation — "Electric Teal: a sharp, cool contrast to the amber." The
	// electric grid teal is for live data (glows); the deep teal is the recessive
	// structural teal used on borders and dim grids (stays under bloom, so the cool
	// frame reads clearly but recedes behind the amber content, per the brief's
	// "push the cooler teal … to the background").
	teal: '#12E5C8', // grid         lum ~0.64 — glows (coordinates, code, crosshair)
	tealDeep: '#0A7E6E', // gridDim + border  lum ~0.35 — crisp, recessive teal
	// Augmentation — "Laser Purple (Magenta/Violet): used for 'injected' or highly
	// advanced processes." Bright enough to glow; the trail violet stays dim.
	purple: '#B14CFF', // inject     lum ~0.50 — glows
	violet: '#5A1A94', // injectDim  lum ~0.23 — crisp dim trail
	// Critical — "Piercing Laser Red." Brightened from a deep crimson so the laser
	// actually *glows* through bloom (a deep red sits below the threshold and would
	// read as a dull dot). Reserved for locks and failures, so it stays rare.
	red: '#FF3344', // alert         lum ~0.45 — glows
	blood: '#7A0011', // alertDim    lum ~0.15 — crisp dim backing
	// Text hierarchy, amber-tinted. Scanlines only darken the background buffer, so
	// legibility here is purely fg-on-black + bloom: bone is bright, umber is a
	// readable dim, ash is faint scaffolding (lifted a touch from pure shadow).
	bone: '#E8B563', // text         lum ~0.73
	umber: '#8A5A12', // textDim     lum ~0.38 — under bloom, so body text never smears
	ash: '#4A2F0E', // textFaint     lum ~0.20 — faint but legible
} as const

export const augmented: Theme = {
	id: 'augmented',
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

		// "Laser Purple … 'injected' processes … cascading code overlays, or data
		// streams that appear to bypass the standard amber system."
		inject: palette.purple,
		injectDim: palette.violet,

		// "Piercing Laser Red. Reserved exclusively for extreme contrast." Used sparingly.
		alert: palette.red,
		alertDim: palette.blood,

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
		// enough to stay under bloom and recede behind the amber content it wraps.
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

	reticle: {
		// "A large amber targeting ring might be surrounded by a fast-spinning,
		// segmented purple ring, with a static teal crosshair in the center." Nested
		// rings "rotate in opposite directions at different speeds" (parallax), and
		// "extreme artificial depth … amber and red to the immediate foreground …
		// cooler teal and purple to the background" (see each ring's `depth`).
		//
		// `phase` parks each ring's gaps on the vertical (12/6 o'clock) so no lit arc
		// smears into a horizontal bar, and staggers the rings' start angles. Values
		// come from `phase = π/2 − wedge·(1+duty)/2` (centres a gap on the cardinal).
		rings: [
			// Outer amber targeting ring — the grounded baseline, slow (+). Foreground
			// (depth 0): "amber … to the immediate foreground." 4 gaps land on the four
			// cardinals, so its lit arcs ride the diagonals as clean curves.
			{ radius: 9, color: palette.amber, speed: 0.35, segments: 4, duty: 0.86, ticks: true, phase: 0.11, depth: 0 },
			// Fast-spinning segmented purple graft — counter-rotating hard (−). Mid plane
			// (depth 0.5 → DIM + ~0.73 alpha): a holographic ring floating behind the amber.
			{ radius: 6.6, color: palette.purple, speed: -2.8, segments: 8, duty: 0.55, phase: 0.96, depth: 0.5 },
			// Teal structural ring — the far plane (depth 1 → DIM + 0.45 alpha), "pushed
			// … to the background." Counter-rotates the purple (+); gap parked on top.
			{ radius: 4.4, color: palette.tealDeep, speed: 0.9, segments: 3, duty: 0.62, phase: -0.13, depth: 1 },
		],
		// "a static teal crosshair in the center."
		crosshair: palette.teal,
		crosshairSpan: 2,
		// "target locks … flashing warnings" — piercing red, on top of everything.
		lock: palette.red,
		// "The animation should feel fast, mechanical, and occasionally unstable." The
		// lock breathes fast (tempo 3.6 rad/s, ~2× tactical) with a big, snappy travel.
		lockPulse: { tempo: 3.6, amplitude: 0.9, gap: 0.8 },
		// The scan head reads teal ("environmental scans or network pings"), orbiting
		// the rim fast, counter to the purple ring for extra parallax. A tight comet.
		sweep: { color: palette.teal, speed: 1.6, trail: 3, rim: 0.4, arc: 0.06, arcGain: 0.03 },
	},

	fx: {
		// "Heavy use of 'bloom' (outer glow) on all elements … intensely bright
		// optical lasers and glowing gas tubes overlapping in dark space." The low
		// threshold is what makes it heavy: every neon — amber, gold, teal, AND the
		// purple/red lasers — crosses it and glows, while the dim text tiers, the
		// teal border, and burnt headings stay just under it and stay crisp. Radius
		// is pinned at 2 (bloom is O(w·h·r²)).
		bloom: { threshold: 0.4, strength: 0.34, radius: 2 },
		// Scanlines only darken the background buffer, which is a transparent void
		// here, so they read as a faint texture over the bloom glow — deliberately
		// lighter/sparser than tactical's CRT (this theme's signature is the bloom,
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
			chromaticAberration: 3,
		},
	},

	// A spinning quarter-arc — a little holographic ring, rendered purple (injected)
	// in the header. Contrast tactical's classic ASCII |/-\ spinner.
	spinner: ['◜', '◝', '◞', '◟'],
	// Narrow, unambiguous-width glyphs only — wide/ambiguous codepoints tear the
	// grid. Hex + box-drawing (the wireframe look) + brackets/slashes/underscores
	// per the brief's typography. (Tactical rains plain ASCII punctuation instead.)
	streamChars: '0123456789ABCDEF╱╲│─┼:.><[]{}/_',
	barRamp: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
}
