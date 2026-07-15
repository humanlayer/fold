import type { Theme } from './types'

/**
 * COVENANT ENERGY HUD — plasma glow, shield harmonics.
 *
 * An alien warship's command surface, read off a curved hardlight display. Hot pink
 * and magenta plasma own the structure — titles, borders, the dominant hue; electric
 * cyan is the cool relief on the shield-lattice readouts and structural data; a rare
 * relic-gold is the one honored graft, a priest-caste gilding (injected refs, count
 * badges, bullets). It all rides on a deep-indigo hull-dark that is never quite
 * black — the glow floor is the ambient energy of the hull, not a bug.
 *
 * THE HARD PROBLEM, solved on purpose: the critical colour has to stay legible
 * against a plasma-pink foundation, and red is magenta's next-door neighbour on the
 * hue wheel — a red caret beside hot-pink text muddies, and their glow haloes blur
 * into one warm smear. So `alert` is not red at all: it is an ACID CONTAINMENT
 * YELLOW, the one hue that shares no dominant channel with the plasma family (pink is
 * R+B, yellow is R+G — the green channel alone, 46 vs 255, tears them apart) and so
 * cannot be confused with it. It is the highest-luma token in the theme and blooms
 * brightest; kept rare (~0.5–1%) and married to the alert glyphs, it screams exactly
 * when it should and never competes with the plasma structure.
 *
 * THE GLOW PARTITION (the central mechanic, §4.4): pink is luma-poor — R .299 + B
 * .114 ≈ 0.41 with almost nothing from green — so a saturated hot plasma-pink can
 * never be "bright". The theme leans into that instead of fighting it: the deep
 * magenta that owns the frame (0.32) and the recessive shield/text tiers sit UNDER
 * the gate and stay crisp, receding; every source that should read as live energy —
 * the pale plasma flare (0.72), the cyan shield (0.67), the relic gold (0.73), the
 * acid warning (0.89), the rose body haze (0.73), and the hot plasma core itself
 * (0.51) — sits ABOVE it and blooms. The "pushing toward white/salmon to clear the
 * gate" the brief warns about is exactly what `flare` is: the hot core keeps the
 * saturated hue at a faint glow, and the pale flare carries the strong bloom on
 * highlights and selected rows.
 *
 * This is the energy-surface theme, so the effects speak the plasma-and-shield
 * vocabulary, not the analog-signal one. The signature failure is
 * `chromaticAberration` — energy refraction, the colour layers of a hardlight
 * projection sliding out of register as shield harmonics beat through it, strongest
 * at the edges, zero at the centre, then snapping back — and on a palette already
 * made of magenta and cyan, the fringes it invents ARE magenta and cyan, so the
 * corruption reads as native energy distortion rather than a rendering fault.
 * `chromaDropout` is held at 0: the field splits its layers, it does not drain to
 * gray. Scanlines run heavy for the projection's raster, a fat bright bar rolls
 * through as a refresh harmonic, a soft vignette bends the frame into a dome, and the
 * outer frame is `rounded` — the sweeping curve of alien architecture, the one chrome
 * tell that names the theme across the room (rapture `single`, tactical `heavy`,
 * covenant `rounded`).
 */
const palette = {
	// Void — the hull-dark of an alien warship. Not the absolute black of RAPTURE
	// nor the warm brown-black of TACTICAL: a deep indigo, so the plasma glow (which
	// tints neighbour BACKGROUNDS toward each glyph's colour) bleeds pink and cyan
	// into an ambient energy field rather than into a void. Panels sit a small step
	// above it — a hardlight substrate for the scanlines and vignette to bite into —
	// and the selection band is a deep hot-magenta, the plasma glowing behind the
	// chosen row.
	hull: '#0A0416', // void      lum ~0.03 — the hull-dark, the glow floor
	substrate: '#140A24', // panel     lum ~0.06 — one indigo step above the void
	band: '#34092A', // raised    lum ~0.10 — a deep-magenta selection band

	// Foundation — hot pink / magenta plasma, the glow of an alien energy weapon. This
	// owns the structure the way amber owns RAPTURE. `plasma` is the saturated hot
	// core (glows, but faintly — pink is luma-poor); `flare` is that plasma pushed
	// toward salmon-white so it clears the gate with room to spare and carries the real
	// bloom on highlights and selected identifiers; `magenta` is the deep dim tone that
	// stays crisp under the gate and does double duty as the border — the dominant ~40%
	// of the screen.
	plasma: '#FF3D9A', // core        lum ~0.51 — glows (the saturated plasma core)
	flare: '#FF8FCB', // coreBright  lum ~0.72 — glows hard (the pushed-bright plasma flare)
	magenta: '#B01E63', // coreDim + border  lum ~0.32 — crisp, recessive magenta frame

	// Cool relief — electric cyan, the ship's energy-shield lattice. Luma-rich, so it
	// glows easily; the deeper shield-teal is the recessive structural tone (dim grids,
	// scrollbar tracks) that stays under the gate. This cyan is RELIEF here, never the
	// frame — the border is magenta, so plasma dominates (contrast RAPTURE, where the
	// cool teal owns the border and amber is the accent).
	shield: '#22E4EC', // grid        lum ~0.67 — glows (shield labels, inline code, refs)
	shieldDim: '#0E7A86', // gridDim     lum ~0.36 — crisp, recessive shield-teal

	// Relic light — a honored gold, the one warm graft in a plasma/shield world; the
	// gilding of a priest-caste relic. Lands on "injected" values: cross-references,
	// count badges, bullets. Distinctly ORANGE (R >> G), which is what keeps it clear of
	// the acid warning below (G ≥ R).
	relic: '#FFB13D', // inject       lum ~0.73 — glows (the honored relic-gold)

	// Critical — acid containment yellow, NOT red. The deliberate answer to the
	// pink/red adjacency: yellow is R+G dominant where the plasma family is R+B, so
	// nothing here can be mistaken for a warning. The highest luma in the theme; it
	// blooms hardest, which is the point — but it is rationed to the caret, the CLOSED
	// state and destructive edges, so it stays ~0.5–1% of the screen.
	acid: '#EEFF33', // alert       lum ~0.89 — glows brightest, kept rare

	// Text ramp, tinted toward the plasma foundation the way RAPTURE tints its text
	// amber. `haze` is a dusty rose that reads as body copy lit by the plasma glow
	// (glows, the "glowing mass" of dense text); `mauve` and `plum` are dim/faint
	// scaffolding that sit under the gate and stay crisp.
	haze: '#D9A8C4', // text        lum ~0.73 — glows (rose body haze)
	mauve: '#7E4E68', // textDim     lum ~0.37 — crisp secondary
	plum: '#4A2E42', // textFaint   lum ~0.22 — crisp scaffolding (brackets, empty slots)
} as const

export const covenant: Theme = {
	name: 'COVENANT',
	tagline: 'PLASMA LATTICE // SHIELDS NOMINAL',

	color: {
		// Deep-indigo hull-dark; panels a step above it as a hardlight substrate; the
		// selected row lights a deep-magenta plasma band, never a cool one.
		void: palette.hull,
		panel: palette.substrate,
		raised: palette.band,

		// Hot plasma owns the structure. Core is the saturated bolt (faint glow), flare
		// the pushed-bright discharge (hard glow), magenta the recessive dim tier.
		core: palette.plasma,
		coreBright: palette.flare,
		coreDim: palette.magenta,

		// Cool relief: electric shield-cyan on structural data (coords, inline code,
		// refs), deep shield-teal on dim grids and scrollbar tracks. The theme's cold
		// light — kept off the frame so the plasma stays dominant.
		grid: palette.shield,
		gridDim: palette.shieldDim,

		// "Injected" values ride the relic-gold — the honored light grafted into the
		// plasma.
		inject: palette.relic,

		// Critical: acid yellow, held in reserve so it never blurs into the plasma.
		alert: palette.acid,

		text: palette.haze,
		textDim: palette.mauve,
		textFaint: palette.plum,
	},

	chrome: {
		// `rounded` is COVENANT's tell — the sweeping curve of alien architecture, a
		// Covenant hull built from arcs (RAPTURE is `single`, TACTICAL is `heavy`).
		// Inner panels stay thin `single` lines so the dense grid reads crisply inside
		// the curved frame.
		frameStyle: 'rounded',
		panelStyle: 'single',
		// The border is the deep magenta — the single choice that makes plasma, not
		// shield-cyan, own the screen: it is ~40% of visible cells and sits under the
		// glow gate, so the frame reads unmistakably magenta yet recedes behind the
		// blooming plasma it wraps.
		border: palette.magenta,
		// Panel titles in the hot plasma core.
		title: palette.plasma,
		// Heading prefix: `>> `, a forward chevron — an energy front advancing — pure
		// ASCII, single-width, never tears the cell grid (contrast RAPTURE `// `,
		// TACTICAL `[ `).
		heading: '>> ',
	},

	semantic: {
		// Four states, four distinct hues, so a reader classifies by colour alone:
		//   OPEN   — the live baseline record: hot plasma (reinforces the dominant hue).
		//   MERGED — settled/complete: the one shield-cyan flash, the grid colour used
		//            as a state (rare, like TACTICAL's cyan MERGED — the cool relief
		//            earns a semantic home).
		//   CLOSED — terminated: the acid-yellow alert (rare — closed items are few in
		//            the feed, so alert stays scarce, exactly as red does in the shipped
		//            themes).
		//   DRAFT  — not yet active: dim mauve.
		// No green anywhere.
		open: palette.plasma,
		merged: palette.shield,
		closed: palette.acid,
		draft: palette.mauve,
	},

	fx: {
		// Glow — the plasma bloom. Read by the glyph-aware GlowEffect: only real glyphs
		// emit, and the light lands on neighbour BACKGROUNDS tinted toward the glyph
		// colour, so plasma stays plasma and the indigo hull-dark is only lifted, never
		// washed. The threshold sits at 0.44, dead-centre of the clean 0.14-wide gap
		// between the lowest glowing token (core hot plasma, 0.51) and the highest crisp
		// one (textDim mauve, 0.37): everything meant to read as live energy — flare
		// (0.72), shield-cyan (0.67), relic gold (0.73), acid (0.89), rose text (0.73),
		// and the hot core (0.51) — blooms, while the magenta frame (0.32), the deep
		// shield-teal (0.36) and the faint text (0.22) stay crisp and recede. Strength
		// 0.10 is RAPTURE's proven value on a near-black canvas: enough to halo the hot
		// glyphs without lifting the field (the indigo floor stays the hull-dark). Radius
		// pinned at 2 — the kernel is O(w·h·r²) and is widened by the cell aspect so the
		// halo is round on screen.
		glow: { threshold: 0.44, strength: 0.1, radius: 2 },
		// Scanlines — the hardlight raster, heavier than either shipped theme. Only the
		// BACKGROUND buffer is darkened, so text stays fully legible; step 2 lines every
		// other row and strength 0.75 (lower = darker) makes them bite on the indigo
		// panel substrate as projection lines while barely touching the near-black void
		// (RAPTURE 0.92/step 3, TACTICAL 0.80/step 2 — this is darker still).
		scanlines: { strength: 0.75, step: 2 },
		// Vignette — the curvature of the display dome, corners falling into the housing.
		// Present like TACTICAL's optic (COVENANT is also looking THROUGH something — a
		// curved hardlight projection) but softer (0.6 vs 0.7), pairing with the
		// `rounded` frame to sell the dome. RAPTURE has none.
		vignette: 0.6,
		// CRT bar — a fat, bright refresh harmonic rolling through the frame, the theme's
		// only CONTINUOUS motion (the glitch is punctuation). `speed` is ROWS PER SECOND,
		// not a fraction: the effect advances `position += (deltaMs/1000)*speed` and wraps
		// at `cycleHeight = height*(1 + 2*barHeight)`, so at speed 7 the band sweeps a
		// 44-row terminal in ~8s — a slow, searching scan of the projection. A value like
		// 0.35 would read as "slow" and in fact never move. Fatter (0.12) and brighter
		// (0.5 → 1.5× peak) than RAPTURE's thin scan; a hardlight field's refresh beat,
		// not a clean sweep.
		crtBar: { speed: 7, height: 0.12, intensity: 0.5, fadeDistance: 0.25 },
		glitch: {
			// Bursts a touch more often than the shipped themes — shield harmonics beat
			// against the display readily — but still occasional punctuation, not constant
			// static.
			chancePerSecond: 0.5,
			maxLines: 3,
			maxShift: 10,
			// Favour horizontal shift (the classic refraction slip) over end-to-end flip.
			shiftFlipRatio: 0.7,
			colorGlitchChance: 0.35,
			// A split second, then it snaps back.
			minDuration: 0.05,
			maxDuration: 0.15,

			// The signature: chromatic aberration, the whole-frame lead. This is plasma
			// refraction — the colour layers of a hardlight projection losing register as
			// shield harmonics beat through it, strongest at the edges, zero at the centre,
			// then snapping back — and on a palette already made of magenta and cyan, the
			// fringes it invents ARE magenta and cyan, so the tearing reads as native
			// energy distortion instead of a fault. Set a shade stronger than RAPTURE's 3
			// because the refraction should be visible. Dropout stays 0 — this field splits
			// its layers, it does not desaturate (exactly one whole-frame pass runs).
			chromaticAberration: 4,
			chromaDropout: 0,

			// Aberration MOVES colour; these PAINT the colour it cannot invent, after the
			// aberration so the injected cells keep full saturation. Drawn from the energy
			// set — plasma, flare, shield-cyan, the relic-gold, and the acid warning — so a
			// burst splashes the display with the theme's own energy (every hue a palette
			// token; no literal escapes theme/*). Cool hues are on-brand here (unlike
			// TACTICAL), which is the whole point of the energy-surface look.
			corruptColors: [palette.plasma, palette.flare, palette.shield, palette.relic, palette.acid],
			// Aberration carries the whole-frame punch, so injection is the accent:
			// moderate blocks (field-dropout tiles over the logo, borders) and tinted runs,
			// between RAPTURE's sparse and TACTICAL's chunky settings.
			blockChance: 0.65,
			maxBlocks: 3,
			tintChance: 0.65,
			maxTints: 3,
		},
	},

	barRamp: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
	sparkRamp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
}
