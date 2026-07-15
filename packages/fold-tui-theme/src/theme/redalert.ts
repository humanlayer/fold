import type { Theme } from './types'

/**
 * RED ALERT — MASTER ALARM.
 *
 * An anime mech cockpit at the instant the master alarm trips. Not a dying analog
 * warship — a DIGITAL combat HUD screaming in an error state: NERV-emergency /
 * Gundam-klaxon red, razor-sharp and saturated, stamped on near-pure black. Every
 * readout burns the same signal red, hard-edged and angular, and the only things
 * that break the red are the master-alarm strobe (white), a caution-standby light
 * (hazard yellow), and a single cold sync confirmation (cyan). This is the loudest
 * theme in the set — a klaxon in visual form — where RAPTURE is a lab and
 * TACTICAL is a lens.
 *
 * ── The inversion (the whole design problem) ─────────────────────────────────
 * In every other theme red is the *rare* critical colour: scarce precisely so it can
 * mean "failure". Here red is the FOUNDATION — it owns the border, the structure, the
 * text ramp, the OPEN baseline. So `alert` cannot be red; a red warning in an all-red
 * world is invisible. The critical slot has to be the one thing that still cuts
 * through a screen already screaming red.
 *
 * The answer is a **white strobe** (`strobe`, L 0.96): the master-alarm flash, the
 * only thing brighter than a red-lit cockpit. It is the highest-luma token by a mile,
 * so it blooms hardest under the glow; and it is bound only to the selection caret,
 * the destructive branch arrow, and a spent rate limit, so it stays RARE (well under
 * 1% of cells — §4.3). Scarcity is what makes the white flash read as "critical"
 * instead of "a colour". Rejected: hazard yellow as the alert (it drifts warm, muddies
 * against the reds, and is already spent on `draft`); a cold flash (already spent — see
 * `sync` below; a second cold token would dilute the one we have).
 *
 * ── Sharp red, not rust (the redesign mandate) ───────────────────────────────
 * The previous cut of this theme was a rusted warship: oxidised copper relief
 * (#C86A3A) and a rust frame (#7A3320) over a red-brown murk void (#110505). That read
 * as a failing analog ship, not a mech alarm. RED ALERT kills every brown/orange cast.
 * The whole red family is now **blue-shadowed** — the blue channel is ≥ the green in
 * every red token — so nothing can drift toward orange/rust; the hues sit on the
 * crimson/scarlet side of red, which is what reads as *sharp*. The void drops to a
 * barely-red-tinted near-black (blacker + cleaner than the old murk), and the recessive
 * frame becomes a deep saturated crimson (green literally 0) instead of rust. Where the
 * old file lifted a red's luma by *adding green* (→ orange), this one keeps green low
 * and engineers the whole ramp by **lightness alone**.
 *
 * ── Beating the all-red mud ──────────────────────────────────────────────────
 * Red is luma-poor (the R coefficient is only 0.299), so a saturated red sits LOW on
 * Rec. 601 luma and a whole screen of it collapses into one illegible wash. Separation
 * is bought three ways. (1) LUMA SPREAD: the live tier climbs signal(0.40) →
 * roseSteel(0.46) → hot(0.55) → rose text(0.66), and the text ramp is deliberately
 * offset off the structure (rose text 0.66 rides well above signal red 0.40 so body
 * copy never fuses with titles — the same trick RAPTURE plays with bone-over-amber).
 * The hot spike (0.55) sits *below* the rose text (0.66) on purpose: a sharp red caps
 * out in luma before a light rose does, so `coreBright` pops by SATURATION, not by being
 * the brightest thing. (2) SATURATION: signal red is fully saturated for the live
 * alarm, roseSteel is a desaturated "metal" for the calmer relief, and they read apart
 * even where their luma is close. (3) THREE NON-RED ANCHORS held in reserve — the white
 * strobe, the cyan sync, the hazard yellow — that break the field precisely because
 * they are rare.
 *
 * ── Relief under the alarm ───────────────────────────────────────────────────
 * `grid`/`gridDim` are the "relief" slots. RAPTURE spends them on opposite-hue teal;
 * TACTICAL keeps them warm gold. RED ALERT keeps them RED but *desaturated*: `roseSteel`
 * is the instrument housing catching the alarm light — a calmer red-grey on live labels
 * and refs — and `crimson` is the recessive frame. Both stay blue-shadowed, so neither
 * can drift back to the rust/copper the redesign rejects. A cold steel-blue relief was
 * refused: it would compete with the one cold accent (`sync`) and stop cyan from being
 * rare. The real chromatic relief in this theme is not a common slot at all — it is the
 * scarce strobe / sync / hazard.
 *
 * ── Glitch idiom: digital, not analog ────────────────────────────────────────
 * The old cut browned out (chroma dropout) like a tube losing power — an *analog*
 * failure. A mech HUD is a DIGITAL compositor, so RED ALERT switches to **chromatic
 * aberration**: during an alarm strobe the render layers lose registration and tear
 * apart (RGB split, growing from the screen centre, strongest at the edges), then snap
 * back. The momentary cyan/magenta fringe is the digital desync itself — exactly what a
 * glitching HUD does — and it even rhymes with the cyan sync light. `chromaDropout` is
 * held at 0. The injection pass still paints only red/burnt hues (never the white, cyan,
 * or yellow accents), so the STAMPED corruption reads as the red world glitching while
 * the LAYER TEAR reads as digital desync.
 */
const palette = {
	// Backgrounds — near-pure black, barely bled with red. The old cut's #110505 /
	// #1A0707 read as red-brown murk; RED ALERT drops the void to a blacker, cleaner
	// black (only R lifted above G/B, and only just) so the alarm content has maximum
	// contrast to bloom against. Panel is a whisper above the void; the selected row is
	// a clearly-lit sharp-crimson band.
	void: '#050102', // L 0.009 — barely-red-tinted near-black
	panel: '#0C0304', // L 0.023 — a whisper above the void
	raised: '#560717', // L 0.127 — sharp crimson band behind the selected row

	// Foundation — the master-alarm red. Signal red owns the structure; hot red is the
	// spike/highlight; ember red is the dim crisp heading tone. All BLUE-SHADOWED (blue
	// channel ≥ green) so the family reads as razor crimson/scarlet, never rust or coral.
	// Placed by luma deliberately: signal sits just over the 0.35 glow gate (a faint
	// halo, the lamp emitting), hot is pushed higher to bloom, ember stays under the gate.
	signalRed: '#FF2233', // core      L 0.400 — glows (just clears the gate)
	hotRed: '#FF5A6A', // coreBright + inject  L 0.554 — glows (the hot alarm spike)
	emberRed: '#B01528', // coreDim    L 0.273 — crisp (headings, recessive structure)

	// Relief — the instrument housing lit red. RoseSteel is a DESATURATED red (calmer
	// "metal under the alarm") on live labels / inline code / refs; crimson is the deep
	// recessive frame. Both blue-shadowed, so neither drifts to the rejected copper/rust.
	roseSteel: '#B45A64', // grid      L 0.463 — glows (labels, inline code, refs)
	crimson: '#9E0020', // gridDim + border   L 0.200 — crisp, deep frame (~40% of cells)

	// Critical — the master-alarm STROBE. In an all-red world a red warning is invisible,
	// so the critical token is the one thing brighter than the red: a white flash. Highest
	// luma in the palette, so it blooms hardest; bound only to the caret / destructive
	// arrow / spent rate limit, so it stays RARE. A whisper of red (R 255, G=B 240) keeps
	// it in-world as "the alarm gone white", not chrome.
	strobe: '#FFF0F0', // alert        L 0.959 — glows hardest. RARE (~<1%).

	// The single cold light — SYNC COMPLETE. One system re-synced to the net: the entire
	// cool budget of the theme, spent (as TACTICAL spends its cyan) on exactly one surface,
	// a MERGED record. Cold means "restored / nominal" and nothing else; never a corrupt hue.
	sync: '#26DCCE', // merged         L 0.643 — glows. RARE (~0.5%).

	// The caution light — STANDBY. Hazard / master-caution yellow (the very-anime klaxon
	// amber): a DRAFT is a system spinning up, not yet armed. Warm on purpose — a hazard
	// light IS warm — but bound to one rare state, so it never muddies the red field.
	hazard: '#FFCE1F', // draft        L 0.787 — glows. RARE (~1%).

	// De-energised — cold dead slate, the palette's only near-neutral. A CLOSED item is a
	// safed / offline system: it cannot be red (invisible here) and must not be the white
	// strobe (that stays rare), so a cold grey reads cleanly as "no power".
	slate: '#4A4652', // closed        L 0.285 — crisp

	// Text ramp — rose, lifted tonally off the signal-red structure so body copy never
	// muds into titles (rose text 0.66 rides well above signal red 0.40). Rose glows; the
	// dim tiers stay crisp on the near-black void (the glow only ever touches backgrounds).
	rose: '#EC8892', // text          L 0.655 — glows
	roseDim: '#7E343C', // textDim     L 0.294 — crisp (just under the gate)
	maroon: '#4A171D', // textFaint    L 0.153 — crisp scaffolding (brackets, empty slots)

	// Glitch-only burnt cells — used by nothing but a corruption burst. Dark red-greys
	// (blue-shadowed, so still in-world) that read as dead / burnt pixels; a neutral grey
	// would read as generic UI chrome, not a fault.
	char: '#3A2228', // L 0.164 — burnt cell
	charDim: '#241417', // L 0.099 — darker burnt cell
} as const

export const redalert: Theme = {
	name: 'RED ALERT',
	tagline: 'MASTER ALARM // ALL SYSTEMS RED',

	color: {
		// Near-pure black void; a whisper-dim panel above it; a clearly-lit sharp-crimson
		// band behind the active row (never a cool fill — the whole world is red here).
		void: palette.void,
		panel: palette.panel,
		raised: palette.raised,

		// Signal red owns the structure (titles, primary readouts, the OPEN baseline); hot
		// red is the spike highlight; ember red is the dim heading tone.
		core: palette.signalRed,
		coreBright: palette.hotRed,
		coreDim: palette.emberRed,

		// Relief is desaturated red — roseSteel (bright, live labels/refs) / crimson (dim,
		// the frame): warm structure that recedes behind the signal-red alarms rather than a
		// cold contrast. Routing relief through cold steel would spend the cyan budget that
		// `semantic.merged` needs; here the only cold light in the UI is that sync flash.
		grid: palette.roseSteel,
		gridDim: palette.crimson,

		// No separate "graft" hue exists on a single-system alarm: injected values
		// (cross-refs, count badges, bullets) simply run HOT — the same hot red, spiking.
		// This mirrors TACTICAL routing inject → its coreBright.
		inject: palette.hotRed,

		// CRITICAL — the white master-alarm strobe, the inversion this theme is built
		// around. Rare: only the selection caret, the destructive branch arrow, and a spent
		// rate limit. A red alert would vanish in a red world; a white strobe does not.
		alert: palette.strobe,

		text: palette.rose,
		textDim: palette.roseDim,
		textFaint: palette.maroon,
	},

	chrome: {
		// 'heavy' outer framing is the cockpit's chunky armour — thick bulkhead lines. The
		// inner panels take 'double' (the one border style neither exemplar claimed:
		// RAPTURE is single/single, TACTICAL heavy/single) so compartments read as
		// double-sealed hull sections — RED ALERT's frame tell at a glance.
		frameStyle: 'heavy',
		panelStyle: 'double',
		// The dominant colour on screen (~40% of cells). Recessive deep crimson: sharp and
		// unmistakably red (green literally 0), but dark and well under the glow gate, so the
		// frame stays crisp and recedes while the signal-red content blooms forward.
		border: palette.crimson,
		// Panel titles in the alarm signal red — the structure's own hue.
		title: palette.signalRed,
		// Master-alarm heading prefix: every section stamped like a klaxon line. Narrow ASCII
		// (safe width). RAPTURE uses '// ', TACTICAL '[ '; RED ALERT shouts '!! '.
		heading: '!! ',
	},

	semantic: {
		// A scarcity-first ladder for a mech cockpit. OPEN is the live/armed baseline, so it
		// is the foundation signal red — the dominant state, on-brand for a red world. MERGED
		// spends the entire cool budget on one cold sync flash: a system re-synced to normal,
		// rare and striking. CLOSED is a safed/de-energised system, so it is the dead slate —
		// offline, no power (it cannot be red, and must not be the rare white strobe). DRAFT
		// is STANDBY: a system spinning up, marked with the hazard/caution yellow.
		open: palette.signalRed,
		merged: palette.sync,
		closed: palette.slate,
		draft: palette.hazard,
	},

	fx: {
		// Alarm light glows. Read by the glyph-aware GlowEffect (only real glyphs emit; the
		// light lands on neighbour BACKGROUNDS tinted toward the glyph colour, never on the
		// foreground or the void). The 0.35 threshold sits in the one clean luma gap the
		// palette has — between the highest crisp token (roseDim 0.294) and the lowest glowing
		// token (signal red 0.400), a 0.106-wide gap, wider and cleaner than the old cut's.
		// Above it the whole live tier blooms: signal red(0.40, a structural halo),
		// roseSteel(0.46), hot red(0.55), rose text(0.66), the sync flash(0.64), the hazard
		// caution(0.79) and the strobe(0.96, hardest). Below it the recessive crimson frame
		// (~40% of cells), the ember headings, the dim text tiers and the dead slate all stay
		// crisp. Strength is modest — the crimson frame is crisp and never lifts the field, so
		// only the hot content halos; pushing past ~0.15 washes the screen. Radius pinned at 2
		// (kernel is O(w·h·r²), widened by cell aspect so the halo is round).
		glow: { threshold: 0.35, strength: 0.09, radius: 2 },
		// Dense scanlines — a digital raster under the alarm. `applyScanlines` multiplies the
		// BACKGROUND by `strength` on every `step`-th row (lower = darker lines, smaller step =
		// denser). Every other row, a fine texture carved into the glow halo (on the near-black
		// void there is little background to darken except where the glow has lit it).
		scanlines: { strength: 0.85, step: 2 },
		// Cockpit focus, kept LIGHT. The old 0.75 vignette pooled the red-brown murk into the
		// corners and was most of the murk complaint; a digital HUD barely warrants an optical
		// tunnel, so this drops to a whisper (0.30 "heavy") — just enough master-alarm
		// tunnel-vision, not enough to eat the black-level contrast the redesign is after.
		vignette: 0.3,
		// The klaxon sweep — RED ALERT's only continuous motion (the glitch is punctuation, not
		// a pulse). `speed` is in **ROWS PER SECOND**, not a screen fraction: the bar advances
		// `position += (deltaMs/1000) * speed` and wraps at `cycleHeight = height * (1 + 2*barHeight)`,
		// so the period is `cycleHeight / speed` seconds. At `speed: 16` that is a fast ~3.2s
		// sweep over a 44-row terminal — deliberately urgent (6–9 reads calm, 12+ reads urgent;
		// 0.35 would be one sweep every two-and-a-half minutes, i.e. frozen). A firm band
		// (height 0.09) pulsing to 1.5× as it passes: the emergency strobe rolling.
		crtBar: { speed: 16, height: 0.09, intensity: 0.5, fadeDistance: 0.25 },
		glitch: {
			// Frequent, urgent bursts — the cockpit is in alarm. A hair more often than either
			// exemplar; the identity is in *how* the colour fails (below), not how often.
			chancePerSecond: 0.55,
			maxLines: 3,
			maxShift: 9,
			shiftFlipRatio: 0.7,
			// Aberration (below) carries most of the colour-fail, so the datamosh smear is the
			// lighter accent (as in RAPTURE), not the lead.
			colorGlitchChance: 0.3,
			minDuration: 0.05,
			maxDuration: 0.15,

			// Systems DESYNCING, not browning out. A DIGITAL compositor: during the strobe the
			// RGB layers slide out of register (growing from centre, strongest at the edges),
			// then snap back. The transient cyan/magenta fringe is the desync itself — on-story
			// for a glitching HUD, and it rhymes with the cyan sync light. Dropout (the analog
			// idiom the old cut used) is held at 0: this machine is digital, not a dying tube.
			chromaticAberration: 3,
			chromaDropout: 0,

			// The colour a burst PAINTS (stamped AFTER the aberration, so it keeps full
			// saturation). Signal/hot/ember red, the crimson frame, and the two burnt cells —
			// the red world corrupting, never a cool hue and never the strobe/sync/hazard: those
			// accents are kept out of the corrupt set so they stay rare and meaningful. So the
			// LAYER TEAR invents cool fringes (digital desync) while the INJECTION stamps red
			// (the world glitching) — two distinct jobs, kept distinct. Every entry is a palette
			// token (no literal escapes theme/*); postfx parses these to RGB once at install.
			corruptColors: [
				palette.signalRed,
				palette.hotRed,
				palette.emberRed,
				palette.crimson,
				palette.char,
				palette.charDim,
			],
			// Aberration already carries the whole-frame punch, so injection is the accent, not
			// the lead — a touch finer/rarer than the old dropout-driven cut (which had to paint
			// everything back), matching RAPTURE's aberration-plus-light-injection balance.
			blockChance: 0.65,
			maxBlocks: 2,
			tintChance: 0.65,
			maxTints: 3,
		},
	},

	barRamp: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
	sparkRamp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
}
