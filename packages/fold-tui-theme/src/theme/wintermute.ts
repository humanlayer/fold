import type { Theme } from './types'

/**
 * WINTERMUTE — the self-diagnostic surface of an orbital AI.
 *
 * You are looking at a vast machine auditing itself: glacial, clinical, utterly
 * calm — a precision instrument with nothing to prove. Ice blue and white-blue own
 * the structure (titles, primary readouts, the crystalline frost-lattice frame)
 * over a blue-black void. Steel carries the secondary data; a cold spectral violet
 * is the AI's own voice, surfacing on the records it has touched.
 *
 * The signature of this theme is RESTRAINT — it is defined by what it refuses to
 * do. Where RAPTURE grafts neon and TACTICAL fails like a dying tube, WINTERMUTE
 * holds still. Only the single brightest white-ice tier glows, and only faintly;
 * everything else is crisp, edge-to-edge, with no vignette and no lens — this
 * machine is not looking *through* anything, it *is* the surface.
 *
 * There is exactly one warm colour in the whole theme — a hot thermal amber — the
 * mirror of TACTICAL's one cold flash: the only heat in a glacial world, spent
 * only on faults (`alert` / `closed`). Everything else is ice, steel, or ghost.
 *
 * The glitch is not absent but vanishingly rare: roughly once a minute the digital
 * layers slip a cell or two out of register — chromatic aberration, a *digital*
 * fault, never analog `chromaDropout` — and snap back. A perfect machine that
 * fails once a minute is more unsettling than one that fails constantly; the rare
 * tell is what betrays the calm surface as a facade.
 */
const palette = {
	// A blue-black void — the #020508 family, tuned a shade bluer. Not TACTICAL's
	// warm brown-black nor RAPTURE's absolute black: cold, deep, orbital dark.
	// Panels sit one faint step above it, so the diagnostic surface reads as a
	// *surface*; `raised` is a clear steel band so a selected row is unmistakable.
	void: '#02060C', //          lum ~0.02
	panel: '#050C16', //         lum ~0.04 — a faint substrate step above the void
	raised: '#16345A', //        lum ~0.19 — a cold steel selection band

	// THE FOUNDATION — ice. Glacial blue owns the structure; white-ice is the hot
	// highlight; a dim steel-blue is the recessive heading tone. Ice tones draw their
	// brightness from G+B, not R (blue's luma coefficient is only 0.114, §4.4), so
	// they can sit high in luma while staying unmistakably cold.
	ice: '#62BCEA', //           core        lum ~0.65 — crisp (the calm structure never blooms)
	iceWhite: '#C6E4FF', //      coreBright  lum ~0.87 — the ONLY glowing tier. R is held at 198
	//                                       so even the CRT bar's 1.25x peak can't clamp it to #ffffff
	iceDim: '#2E6B96', //        coreDim     lum ~0.37 — crisp, recessive (headings)

	// STEEL — structural relief. RAPTURE contrasts its amber with a *cool* teal;
	// WINTERMUTE is cold everywhere, so `steel` separates from the `ice` foundation
	// not by a new hue but by being a deeper, greyer, less-saturated blue that recedes.
	steel: '#5688B4', //         grid        lum ~0.49 — labels, inline code, refs
	steelDim: '#305370', //      gridDim + border  lum ~0.30 — the frost-lattice frame, recessive

	// GHOST — the AI's own voice. A cold spectral violet (blue-leaning: B > R > G, so
	// it never reads warm), marking anything "injected": merged records, `#123`
	// cross-references, count badges, bullets. The one non-ice, non-warm signal.
	ghost: '#9E8FDC', //         inject      lum ~0.61 — crisp

	// THE SINGLE WARM SIGNAL — the mirror of TACTICAL's lone cyan flash. In a glacial
	// world the one warm colour is a hot thermal amber: the direct chromatic
	// complement of ice-blue, so it vibrates against the field. Reserved for faults —
	// critical state, the selection caret, destructive edges — so it stays rare (~0.5-2%).
	thermal: '#FF8A24', //       alert       lum ~0.63 — crisp (even the alarm is contained)

	// TEXT — cold near-white down to steel. `rime` is a bluish near-white body tone
	// held just under the glow gate so prose stays crisp; `slateDim` is lifted off
	// pure shadow (lum ~0.26 vs the exemplars' ~0.15-0.20) so faint scaffolding — the
	// brackets, empty bar slots, labels — stays legible against the void.
	rime: '#9CBBD4', //          text        lum ~0.71
	slate: '#5E7C93', //         textDim     lum ~0.46
	slateDim: '#30475A', //      textFaint   lum ~0.26
} as const

export const wintermute: Theme = {
	name: 'WINTERMUTE',
	tagline: 'ICE LATTICE // SELF-DIAGNOSTIC',

	color: {
		// A blue-black void; panels one faint step above it (the diagnostic surface),
		// the selected row a clear cold steel band.
		void: palette.void,
		panel: palette.panel,
		raised: palette.raised,

		// Ice owns the structure; white-ice is the hot highlight; dim ice is the
		// recessive heading tone. The foundation is deliberately CRISP — unlike both
		// exemplars, whose core hue glows, WINTERMUTE keeps the structure clinical and
		// blooms only the rare white-ice highlight (see fx.glow).
		core: palette.ice,
		coreBright: palette.iceWhite,
		coreDim: palette.iceDim,

		// Structural-data slot (coords, repo, refs, inline code). A deeper steel than
		// `core`, so it recedes behind the ice foundation — cold relief without a second
		// hue, the ice-world answer to RAPTURE's teal.
		grid: palette.steel,
		gridDim: palette.steelDim,

		// "Injected" values read as the AI's spectral violet voice — the one non-ice,
		// non-warm signal, surfacing on merged records and cross-references.
		inject: palette.ghost,

		// The single warm colour in the theme, held in reserve for faults.
		alert: palette.thermal,

		text: palette.rime,
		textDim: palette.slate,
		textFaint: palette.slateDim,
	},

	chrome: {
		// 'double' is the WINTERMUTE tell (RAPTURE 'single', TACTICAL 'heavy'): a
		// crystalline double-rule frame that reads as frost / precision engineering and
		// pairs with the "ICE LATTICE" tagline. Inner panels stay thin 'single' steel —
		// clinical, not busy.
		frameStyle: 'double',
		panelStyle: 'single',
		// The recessive steel — unmistakably a cold frost frame (the tell against the
		// other themes' warm/teal frames), dim enough to stay under the glow gate and
		// recede behind the ice it wraps.
		border: palette.steelDim,
		title: palette.ice,
		// A clinical machine-namespace prefix (RAPTURE '// ', TACTICAL '[ '): reads as
		// a diagnostic prompt, not prose.
		heading: ':: ',
	},

	semantic: {
		// A cold-first ladder with one warm rung. OPEN is the live ice-blue baseline;
		// MERGED is the AI's spectral-violet ghost, spliced into a record it touched
		// (mirroring RAPTURE's merged = inject); CLOSED is the lone warm thermal flash
		// — terminated, the only heat; DRAFT is dim steel, not yet active.
		open: palette.ice,
		merged: palette.ghost,
		closed: palette.thermal,
		draft: palette.slate,
	},

	fx: {
		// RESTRAINT, made mechanical. The glow gate is placed in the wide 0.71 -> 0.87
		// gap between the brightest body text (`rime` 0.71) and the white-ice highlight
		// (`iceWhite` 0.87), so EXACTLY ONE token crosses it. The glacial structure, the
		// steel, the violet ghost and the warm alert all sit below the gate and stay
		// crisp; only the rare white-ice highlight blooms, and — normalized to
		// (0.87-0.78)/(1-0.78) ~= 0.41 at strength 0.10 — only faintly. Note the strength
		// equals RAPTURE's, yet six of RAPTURE's tokens emit and only one of
		// WINTERMUTE's does: the restraint lives in the GATE, not the strength. This
		// single-tier partition is the theme's identity — a machine so precise that
		// almost nothing about it emits. Radius pinned at 2 (kernel is O(w·h·r²), widened
		// by the ~2:1 cell aspect so the halo is round on screen).
		glow: { threshold: 0.78, strength: 0.1, radius: 2 },
		// Sparse and faint. `applyScanlines` multiplies the BACKGROUND by `strength` on
		// every `step`-th row (lower = darker lines, smaller step = denser). 0.94 is
		// *lighter* than RAPTURE's 0.92, and step 3 keeps them sparse — a barely-there
		// texture carved into the faint panel + glow halo, never a heavy CRT grille.
		scanlines: { strength: 0.94, step: 3 },
		// No vignette (RAPTURE has none either): a vignette is an optic tunnel, and
		// WINTERMUTE is not looking *through* a lens — it *is* the surface, clear from
		// edge to edge. Omitting the token makes the footer honestly read `V VIGNETTE:--`.
		//
		// A slow, thin, gentle CRT bar — the diagnostic sweep, and the theme's only
		// *continuous* motion. With the glitch this rare, dropping the bar too would ship
		// a still image (§7.3/§7.5), and a self-audit sweep is exactly in-story. `speed`
		// is ROWS PER SECOND: 5 is a ~11s sweep over 44 rows — the calmest of the three
		// (RAPTURE 9, TACTICAL 6). Thin (0.06) like RAPTURE's scan line, and gentler
		// than either (peak 1.25x vs 1.35/1.5) with a soft edge (fadeDistance 0.4). A
		// patient machine watching itself.
		crtBar: { speed: 5, height: 0.06, intensity: 0.25, fadeDistance: 0.4 },
		glitch: {
			// VANISHINGLY RARE, by design: ~1 burst every ~50s (0.02/s). A perfect machine
			// that fails once a minute is more unsettling than one that fails constantly —
			// the rare tell hints the calm is a facade. When it does fire it is minimal: a
			// SINGLE torn row (maxLines 1) slipping at most 3 cells, a brief 2-3 frame blip
			// (0.05-0.10s), rarely a mirror (shiftFlipRatio 0.9), rarely a colour smear (0.2).
			chancePerSecond: 0.02,
			maxLines: 1,
			maxShift: 3,
			shiftFlipRatio: 0.9,
			colorGlitchChance: 0.2,
			minDuration: 0.05,
			maxDuration: 0.1,

			// A *digital* intelligence fails by losing register between precise layers, not
			// by an analog tube losing chroma — so aberration carries the whole-frame pass
			// and dropout stays 0. Held to 2 (RAPTURE 3): the colour layers slide a cell
			// or two apart at the edges, zero at centre, then snap back. Precise, subtle, cold.
			chromaticAberration: 2,
			chromaDropout: 0,

			// The colour a burst PAINTS — cold only, staying inside the ice world (the
			// discipline TACTICAL applies to its warm palette, inverted). The warm `thermal`
			// is deliberately absent, so it never appears except on a real fault. No blocks
			// (blockChance 0): a solid stamped tile is too loud for this calm surface. Just
			// an occasional single tinted run — the AI's ice/ghost bleeding through for a few
			// frames, the one chilling accent on the rare aberration.
			corruptColors: [palette.iceWhite, palette.ice, palette.steel, palette.ghost],
			blockChance: 0,
			maxBlocks: 1,
			tintChance: 0.35,
			maxTints: 1,
		},
	},

	barRamp: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
	sparkRamp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
}
