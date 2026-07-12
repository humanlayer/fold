import type { Theme } from './types'

/**
 * RAPTURE — a drowned art-deco city, lit only from within.
 *
 * A sunken utopia on the floor of the ocean: brass filament light and gilded deco
 * structure holding against the pressure, the whole splendid city visible only
 * because it makes its own light. Amber IS that structure — the incandescent lamps
 * and the beaten-brass lines; gold is the gilding, the hottest highlight; burnt
 * umber is the brass gone to shadow. Electric teal is the sea itself, the cold ocean
 * light pressing on the glass, cast across every label and readout. Laser purple is
 * the neon signage of a golden age gone strange, marking anything "injected" —
 * spliced records, `#123` cross-references, count badges, bullets. Piercing red is
 * the rare emergency among the splendour: failures and destructive edges only.
 * Everything hangs in absolute-black water — the lightless deep — and, exactly as it
 * would down there, the UI supplies 100% of the light.
 *
 * The signature failure is not a dropout but a SPLICE. When a shock passes, the
 * amber, teal and purple layers slide out of register — chromatic aberration — and
 * snap back: a spliced system losing coherence between its colour layers, the city's
 * own splicing come loose for a split second. Not a dying tube; a spliced system.
 *
 * Spectacular, dense, drowning.
 */
const palette = {
	black: '#000000',
	// The structure — brass and filament. The incandescent amber lamps and the beaten-
	// deco lines that hold the city up against the pressure. Amber and gold burn bright
	// enough to cross the glow threshold; the burnt brass in shadow stays under it so
	// headings read crisp.
	amber: '#FFA31A', // core        lum ~0.69 — glows
	gold: '#FFD447', // coreBright   lum ~0.82 — glows
	burnt: '#A34A00', // coreDim     lum ~0.36 — crisp (headings)
	amberEmber: '#2A1A0C', // raised — a warm filament ember behind the selected row, never a cool fill
	// The sea — electric teal, the cold ocean light pressing on the glass. The bright
	// brine is live data (glows); the deep brine is the recessive structural water on
	// borders and dim grids (stays under the glow gate, so the cold frame reads clearly
	// but recedes behind the warm brass content).
	brine: '#12E5C8', // grid         lum ~0.64 — glows (labels, inline code, branch refs)
	brineDeep: '#0A7E6E', // gridDim + border  lum ~0.35 — crisp, recessive sea
	// The signage — laser purple, the neon of a golden age gone strange. Marks anything
	// "injected". Bright enough to cross the glow threshold.
	purple: '#B14CFF', // inject     lum ~0.50 — glows
	// The emergency — piercing red. Brightened from a deep crimson so the siren actually
	// *glows* (a deep red sits below the threshold and would read as a dull dot). Reserved
	// for failures and destructive edges, so it stays rare — the one alarm in the splendour.
	red: '#FF3344', // alert         lum ~0.45 — glows
	// Text hierarchy, amber-tinted. Scanlines only darken the *background* buffer, so
	// legibility here is purely foreground-on-black: bone is bright, umber is a readable
	// dim, ash is faint scaffolding (lifted a touch from pure shadow).
	bone: '#E8B563', // text         lum ~0.73
	umber: '#8A5A12', // textDim     lum ~0.38 — under the glow gate, so body text stays crisp
	ash: '#4A2F0E', // textFaint     lum ~0.20 — faint but legible
} as const

export const rapture: Theme = {
	name: 'RAPTURE',
	tagline: 'DROWNED DECO // NEON SPLICE',

	color: {
		// The lightless deep: absolute-black water. The city supplies 100% of the light.
		void: palette.black,
		panel: 'transparent', // the black water shows through every panel
		raised: palette.amberEmber, // a selected row glows like a filament, not a cool band

		// The brass structure — primary readouts, deco wireframes, the lamps themselves.
		core: palette.amber,
		coreBright: palette.gold,
		coreDim: palette.burnt,

		// The sea light — structural grids, bounding boxes, cold readouts. Lands on
		// coordinates, inline code, branch refs.
		grid: palette.brine,
		gridDim: palette.brineDeep,

		// The neon signage — "injected" values: spliced records, `#123` cross-references,
		// tab counts, and body bullets.
		inject: palette.purple,

		// The emergency siren, reserved for extreme contrast. Used sparingly: the selection
		// caret, the CLOSED state, the branch arrow, a spent rate limit.
		alert: palette.red,

		text: palette.bone,
		textDim: palette.umber,
		textFaint: palette.ash,
	},

	chrome: {
		// 'single' is the RAPTURE tell (TACTICAL goes 'heavy'): a thin frame, and the cold
		// sea-teal is the relief the palette wants against the warm brass structure.
		frameStyle: 'single',
		panelStyle: 'single',
		// The recessive deep brine — unmistakably a sea-teal frame (the tell against
		// TACTICAL's burnt-orange 'heavy' frame) but dim enough to stay under the glow gate
		// and recede behind the brass it wraps.
		border: palette.brineDeep,
		title: palette.amber,
		heading: '// ', // slashes, brackets and underscores — the city's machine tongue
	},

	semantic: {
		// Colour classifies the record. No green anywhere.
		//   OPEN   — the live baseline, lit brass amber (keeps teal reserved for structure).
		//   MERGED — a branch spliced into the amber city: the neon purple graft.
		//   CLOSED — a terminated/failed record: red (and rare — ~1 per tab in the feed).
		//   DRAFT  — a not-yet-active baseline: dim amber.
		open: palette.amber,
		merged: palette.purple,
		closed: palette.red,
		draft: palette.umber,
	},

	fx: {
		// The city glows — every lamp and neon sign haloed against the black water. Read
		// by the glyph-aware GlowEffect: only real glyphs emit, and the glow lands on the
		// BACKGROUND of neighbours (tinted toward the glyph's colour), so amber stays amber
		// and the deep stays black. The low threshold is what makes it lavish — every neon
		// crosses it and blooms: amber (0.69), gold (0.82), the brine-teal (0.64), and
		// crucially the purple (0.50) and red (0.45) signs, which a higher gate would drown.
		// The dim tiers, the deep-brine border and the burnt headings sit just under it and
		// stay crisp. Strength is deliberately modest: the glow haloes the hottest glyphs
		// (background luminance p99 ≈ 0.46), it does not flood the water — the median cell
		// stays at 0.02 and the deep reads black. Pushing strength past ~0.15 washes a
		// quarter of the screen and the palette stops being legible. Radius is pinned at 2:
		// the kernel is O(w·h·r²), and it spans `r * CELL_ASPECT` cells horizontally so the
		// halo is round on screen.
		glow: { threshold: 0.4, strength: 0.1, radius: 2 },
		// Scanlines only darken the background buffer, which is transparent black water
		// here, so they read as a faint caustic over the glow halo — deliberately lighter
		// and sparser than TACTICAL's CRT (this theme's signature is the glow, not the tube).
		scanlines: { strength: 0.92, step: 3 },
		// A slow sweep of light, not a tube roll. `CRTRollingBarEffect` multiplies
		// foreground *and* background, but this canvas is black water, so only the glyphs
		// brighten: a band of the city flares as the sweep passes, like a searchlight
		// crossing the deep. Faster, thinner and gentler than TACTICAL's (speed 9 rows/s ≈
		// a 6s sweep at 44 rows; 1.35x peak vs 1.5x) — this city is being surveyed, not
		// failing. No vignette: an optic tunnel belongs to the theme looking *through*
		// something.
		crtBar: { speed: 9, height: 0.06, intensity: 0.35, fadeDistance: 0.35 },
		glitch: {
			// Fast, mechanical, occasionally unstable — ~1 burst every couple of seconds,
			// occasional, not constant static. The city flickers like failing wiring.
			chancePerSecond: 0.5,
			maxLines: 3,
			maxShift: 8,
			// Favour horizontal misalignment (shift) over datamosh colour-smear: the move
			// here is layers sliding sideways and snapping back, not a smear.
			shiftFlipRatio: 0.7,
			colorGlitchChance: 0.3,
			// A split second, then it snaps back.
			minDuration: 0.05,
			maxDuration: 0.14,
			// The signature move — the SPLICE coming loose. A shock passes and the amber,
			// brine-teal and purple layers slide out of register for a split second
			// (chromatic aberration) before snapping back. Gated to fire *only* during a
			// burst (see GlitchDirector), strongest at the edges, zero at the centre.
			//
			// This is the whole-frame lead (injection below is the accent): the row tearing
			// alone disturbs ~2% of the screen's glyphs, the aberration ~26%. A spliced
			// system loses register between its colour layers.
			chromaticAberration: 3,
			chromaDropout: 0,

			// Aberration moves colour; these PAINT it. The same injection vocabulary as
			// TACTICAL — solid blocks over the bg, tinted foreground runs — but drawn from
			// the spliced neon palette: amber and gold from the brass, the brine-teal and
			// laser purple from the signage, piercing red for the shock. Cool hues are
			// on-brand here (unlike TACTICAL), so the corruption gets to flash them. Blocks
			// and tints paint AFTER the aberration, so an injected block stays a crisp
			// rectangle instead of being split into fringes.
			corruptColors: [palette.amber, palette.gold, palette.brine, palette.purple, palette.red],
			// A touch finer and rarer than TACTICAL: aberration already carries most of the
			// whole-frame punch, so injection is the accent, not the lead.
			blockChance: 0.6,
			maxBlocks: 2,
			tintChance: 0.6,
			maxTints: 3,
		},
	},

	barRamp: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
	sparkRamp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
}
