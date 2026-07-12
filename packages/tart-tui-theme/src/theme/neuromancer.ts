import type { Theme } from './types'

/**
 * NEUROMANCER — green matrix, cold ICE.
 *
 * The other twin. Where WINTERMUTE is the glacial machine auditing itself,
 * NEUROMANCER is the world you jack into: the matrix, cyberspace — "lines of light
 * ranged in the nonspace of the mind." Green is not a status color here — it is the
 * matrix's only native light, the field itself. It owns the *structure*: titles,
 * readouts, the frame, the body text. That is the correct way to spend green
 * (contrast the usual mistake — green as a bootstrap "success" badge inside another
 * world's palette, which reads as a web dashboard). Here green IS the world.
 *
 * The cold cyan is ICE — Intrusion Countermeasures Electronics, the lattice a system
 * throws up between the console cowboy and its data. It surfaces only where guarded
 * structure crosses the deck: labels, refs, inline code, the frame's cool cousin,
 * the MERGED splice. It is present but never owns the screen (countermeasures are
 * local), so the histogram stays matrix-green.
 *
 * The single warm thing on the deck is the amber klaxon: black ICE — the
 * countermeasure that does not just stop you, it burns. It flares only for
 * terminated / critical records. Red-on-green would read as Christmas; a hot amber
 * alarm reads as a burn warning, and amber is itself a real CRT phosphor (P3), so
 * the alarm is "a second phosphor firing." It is the rare warm flash in a cool green
 * world — the mirror image of TACTICAL, a warm world with one rare cold cyan flash.
 *
 * You read the matrix off an analog deck, and it fails like one: chroma sync drifts,
 * the whole frame washes toward gray and snaps back. So `glitch.chromaDropout`
 * carries the burst and `glitch.chromaticAberration` is held at 0 — an RGB channel
 * split would fringe the greens with magenta/cyan and read as a *spliced* system
 * (that is WINTERMUTE's clean digital failure), when this is a *tube*. Heavy CRT
 * artifacting (a fat, slow rolling bar; dense scanlines; corner vignette from the
 * curved glass) sells the age; a generous phosphor bloom on the hot green content
 * sells that the matrix is still live.
 *
 * The glow threshold (0.50) is the central mechanic and here it doubles as the age
 * line. Green is luma-heavy (the 0.587 G coefficient), so the lit matrix content
 * sits high — mint 0.90, phosphorHot 0.81, sage 0.67, phosphor 0.63, ward 0.62,
 * klaxon 0.60 — and all of it blooms. Every dim structural tone was darkened until
 * it fell into a clean gap below the gate — textDim 0.38, wardDim 0.37, the
 * phosphorDim frame 0.33, sageFaint 0.18 — so the frame and scaffolding stay crisp
 * and recede while the live content glows forward. The gate sits in a wide empty
 * band (0.377 → 0.598) with ~0.10 of margin on each side.
 */
const palette = {
	// The dark glass — the deck's screen before the matrix comes up. Not the absolute
	// black of RAPTURE nor the warm brown-black of TACTICAL — a green-black, the
	// faint bias of an unlit phosphor tube. Panels sit a clear step above it (a murky
	// lit substrate) so scanlines and the rolling bar have a background to bite into;
	// on a pure-black canvas both are invisible.
	substrate: '#050C07', // void    lum ~0.04
	murk: '#0A140D', // panel        lum ~0.06 — a step above the void
	band: '#103D1E', // raised       lum ~0.17 — a lit matrix row, ~2.7x the panel

	// FOUNDATION — the matrix. Green owns the structure: titles, primary readouts,
	// headings, the frame. Burned into a P1-phosphor family (#2BD96A/#33FF66), not a
	// bootstrap-success green. Bright tiers cross the glow gate and bloom; the dim
	// tier is pushed well under it so headings and the border read crisp.
	phosphor: '#2FE862', // core        lum ~0.63 — glows
	phosphorHot: '#7CFFA8', // coreBright lum ~0.81 — glows (the hot highlight)
	phosphorDim: '#157A3A', // coreDim   lum ~0.33 — crisp (headings + the border)

	// THE ICE — cold countermeasures. RAPTURE renders structural data in electric
	// teal; NEUROMANCER keeps that cool-relief idea but casts it as ICE (Intrusion
	// Countermeasures Electronics): the cyan lattice a system wards itself with, not
	// the matrix's native light — a cyan-teal (blue channel high, unlike the greens)
	// for labels, refs, inline code. It crosses the gate and glows too — the whole deck
	// is lit — but it is scarce enough on screen to read as a countermeasure, never the
	// world.
	ward: '#1FD6C4', // grid          lum ~0.62 — glows
	wardDim: '#14807A', // gridDim     lum ~0.37 — crisp, recessive ICE (scroll tracks)

	// "INJECTED" — mint-white. Not a foreign hue (as RAPTURE's laser purple) but the
	// matrix *burned in past its native output*: data running so hot the phosphor
	// whites out — the hottest, palest tier, clearly mint-tinted so it never becomes a
	// flat #ffffff wash. Lands on cross-references, count badges, bullets — the same
	// deck, running hot.
	mint: '#B6FFD9', // inject         lum ~0.90 — glows (brightest)

	// CRITICAL — the amber klaxon: black ICE flaring. The only warm hue in the theme,
	// and the only truly warm phosphor — a hot orange-amber burn warning. Kept RARE by
	// usage (closed state, selection caret, destructive edges) — never by dimming, so
	// it still blooms like an alarm lamp lighting up against the green.
	klaxon: '#FF7E14', // alert        lum ~0.60 — glows

	// Text hierarchy — a soft-green ramp so body copy stays inside the matrix. `sage`
	// is lighter than `phosphor` (like RAPTURE's bone over amber) so the saturated
	// core still reads as the brand tone against readable body text. The two dim tiers
	// sit under the gate: crisp, recessive.
	sage: '#5CD98A', // text          lum ~0.67 — glows
	sageDim: '#26824A', // textDim    lum ~0.38 — crisp (secondary, DRAFT)
	sageFaint: '#123D22', // textFaint lum ~0.18 — crisp (brackets, empty slots, labels)

	// Dead phosphor. Used by nothing but the glitch: when a burst injects one of these,
	// a chunk of the deck reads as burnt-out — a cell the matrix stopped emitting, the
	// glass where black ICE scorched it dark. Green-tinted so even the "gray" corruption
	// stays inside the matrix.
	burn: '#566356', // glitch only   lum ~0.37
	burnDim: '#333B34', // glitch only lum ~0.22
} as const

export const neuromancer: Theme = {
	name: 'NEUROMANCER',
	tagline: 'MATRIX FEED // ICE INTACT',

	color: {
		// Green-black deck; a murky lit substrate a clear step above it; a lit green
		// selection band (the band shows as a background, so it never appears in the
		// foreground histogram, but at ~0.17 it reads clearly against the ~0.06 panel).
		void: palette.substrate,
		panel: palette.murk,
		raised: palette.band,

		// The matrix owns the structure. Bright green is the primary readout, hot green
		// is the highlight, dim green is the recessive structural tone (headings).
		core: palette.phosphor,
		coreBright: palette.phosphorHot,
		coreDim: palette.phosphorDim,

		// The ICE lattice: structural data, labels, inline code, branch refs. The one
		// cool family in the palette; scarce enough to read as a countermeasure walled
		// around the data, never as the world's light (that is the green).
		grid: palette.ward,
		gridDim: palette.wardDim,

		// "Injected" values — cross-references, count badges, bullets. Mint-white: the
		// matrix overdriven, not a foreign color (cf. TACTICAL routing inject through its
		// bright yellow rather than importing a hue).
		inject: palette.mint,

		// The klaxon. Reserved for critical/destructive surfaces so it stays rare — the
		// single warm bloom in a green field, black ICE catching light.
		alert: palette.klaxon,

		text: palette.sage,
		textDim: palette.sageDim,
		textFaint: palette.sageFaint,
	},

	chrome: {
		// The theme tell, shared with the twin. RAPTURE frames in `single` teal,
		// TACTICAL in `heavy` burnt orange; NEUROMANCER and WINTERMUTE both take the
		// `double` rule — twin-line box-drawing, fittingly the two halves of one AI — and
		// part ways on colour, not stroke: this frame is green, WINTERMUTE's is ice.
		// Inner panels drop to `single` so the outer double stays the line that reads
		// across the room.
		frameStyle: 'double',
		panelStyle: 'single',
		// Green owns the structure, so the border is the dim phosphor (not the cold ICE):
		// it is the ~40%-of-cells structural mass, and at lum ~0.33 it stays under the
		// glow gate — an unmistakably green frame that recedes behind the content it
		// wraps. Routing the border through the ICE teal would hand the screen's dominant
		// share to the countermeasures and invert the story.
		border: palette.phosphorDim,
		title: palette.phosphor,
		// A command-prompt caret for the section-heading prefix (RAPTURE uses `// `,
		// TACTICAL `[ `, WINTERMUTE `:: `). Narrow ASCII, and exactly the glyph a deck
		// stamps in front of a line it is waiting on.
		heading: '> ',
	},

	semantic: {
		// The scarcity story, mirrored from the exemplars: TACTICAL spends its whole cool
		// budget on one MERGED cyan; NEUROMANCER spends its whole WARM budget on CLOSED.
		// Everything else stays in the green matrix + cold-ICE world.
		//   OPEN   — the live baseline record: native matrix green.
		//   MERGED — a branch spliced in past the countermeasures: the cold ICE.
		//   CLOSED — terminated/failed: the amber klaxon, black ICE, the rare warm flare.
		//   DRAFT  — not yet burned in: dim green.
		open: palette.phosphor,
		merged: palette.ward,
		closed: palette.klaxon,
		draft: palette.sageDim,
	},

	fx: {
		// The matrix bloom — a glyph-aware outer glow (only real glyphs emit; the light
		// lands on neighbour BACKGROUNDS, tinted toward the glyph colour, never on the
		// void). The gate at 0.50 sits in the wide gap between the lit content (klaxon
		// 0.60, ward 0.62, phosphor 0.63, sage 0.67, phosphorHot 0.81, mint 0.90 — all
		// bloom) and the dim structure (textDim 0.38, wardDim 0.37, the phosphorDim frame
		// 0.33, sageFaint 0.18 — all crisp). Strength 0.09 sits between TACTICAL's
		// restrained 0.07 and RAPTURE's heavy 0.10: a green tube blooms generously, but
		// the canvas is a lit murk (not absolute black), so a hotter value would let the
		// halo lift the whole field. Radius pinned at 2 (the kernel is O(w·h·r²) and is
		// widened by the cell aspect so the halo is round on screen).
		glow: { threshold: 0.5, strength: 0.09, radius: 2 },
		// Dense, fairly dark scanlines — heavier than RAPTURE (0.92 / step 3), matching
		// TACTICAL's density and going a shade darker. `applyScanlines` multiplies
		// background RGB by `strength` on every `step`-th row, so lower strength = darker
		// lines and step 2 = every other row. The murky-green panel gives them something
		// to darken; over the glow halo they read as the raster of the deck's old tube.
		scanlines: { strength: 0.78, step: 2 },
		// Corner darkening from the curved glass of the deck's tube. Distinct in *reason*
		// from TACTICAL's 0.7 optic tunnel (this looks *at* a screen, not *through* an
		// optic), so it is lighter — present as physical tube curvature, not a vignette
		// gunsight.
		vignette: 0.6,
		// A fat, slow rolling bar — the signature continuous motion (the glitch is
		// punctuation, not a pulse) and the reason a continuous render loop is required.
		// `speed` is ROWS PER SECOND: at 6 the sweep takes ~9s over a 44-row terminal
		// (a value like 0.35 would read as "slow" but is one sweep every ~2.5 minutes —
		// a bar that never moves). Fatter (height 0.14) and stronger (intensity 0.6 →
		// a 1.6x peak) than either exemplar: a big tired deck whose refresh drifts, not
		// a tight scan line. It multiplies fg AND bg, so on the lit murk both the glyphs
		// and the substrate flare as the band passes.
		crtBar: { speed: 6, height: 0.14, intensity: 0.6, fadeDistance: 0.2 },
		glitch: {
			// The matrix is robust, so bursts are a touch rarer than the exemplars — but
			// when the deck slips, it slips hard. Bursts pick the same rows for their
			// 2–4 frames (the tear holds, then snaps back), and are applied only to the
			// frame buffer, never the UI tree.
			chancePerSecond: 0.4,
			maxLines: 3,
			maxShift: 10,
			shiftFlipRatio: 0.72,
			// With no channel split to carry colour, datamosh smear is this theme's
			// language (as it is TACTICAL's) — a run of text holding a neighbour's colour.
			colorGlitchChance: 0.4,
			minDuration: 0.05,
			maxDuration: 0.16,

			// THE analog failure, and the sharpest FX differentiator from the channel-split
			// themes (RAPTURE, and its own twin WINTERMUTE): no channel separation. The
			// tube loses chroma sync and the whole frame washes toward its own Rec.601 luma
			// for a few frames, then snaps back. Dropout invents no hues (it can only pull
			// toward gray) — which is exactly why it never smuggles a wrong colour into the
			// palette, and exactly why it needs the injection passes below to repaint the
			// corruption. Pushed to 0.45 (vs TACTICAL's 0.4): an older, flakier tube
			// desaturates harder.
			chromaticAberration: 0,
			chromaDropout: 0.45,

			// The colours a burst PAINTS (blocks over the bg, tinted fg runs), drawn only
			// from palette tokens. Unlike TACTICAL — a warm world that forbids cool
			// corruption — NEUROMANCER's world IS green/ICE, so cool hues are on-brand
			// here: the deck glitches into matrix green, hot green, cold ICE, the amber
			// klaxon, and dead burnt-out phosphor. Painted AFTER dropout, so they survive
			// the burst at full saturation instead of being washed back to gray.
			corruptColors: [
				palette.phosphor,
				palette.phosphorHot,
				palette.ward,
				palette.klaxon,
				palette.burn,
				palette.burnDim,
			],
			// Heavy injection, matching the chunky double frame: dropout alone would only
			// darken, so most bursts stamp several solid blocks (over the TART logo, over
			// borders) and inject a few tinted runs.
			blockChance: 0.8,
			maxBlocks: 4,
			tintChance: 0.75,
			maxTints: 3,
		},
	},

	barRamp: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
	sparkRamp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
}
