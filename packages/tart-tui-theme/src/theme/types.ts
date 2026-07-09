import type { BorderStyle } from '@opentui/core'

export type ThemeId = 'augmented' | 'tactical'

export interface GlitchSpec {
	/** Expected number of glitch bursts per second. */
	readonly chancePerSecond: number
	readonly maxLines: number
	readonly maxShift: number
	readonly shiftFlipRatio: number
	readonly colorGlitchChance: number
	readonly minDuration: number
	readonly maxDuration: number

	/*
	 * A burst's colour work is two distinct jobs. First, a whole-frame pass that
	 * *removes or moves* colour (aberration, dropout). Second, an injection pass
	 * that *paints* colour (blocks, tints). Row tearing alone disturbs ~2% of the
	 * screen's glyphs — perceptually almost nothing; practically all of a glitch's
	 * punch comes from these.
	 */

	/*
	 * -- Whole-frame passes: recolour by MOVING or DESATURATING existing colour. --
	 * Neither can add a hue that was not already on screen. A theme picks the one
	 * that fits *what kind of machine is failing*; the other stays 0.
	 */

	/**
	 * RGB channels slide apart horizontally, offset growing with radial distance
	 * from the screen center. Reads as separate color layers momentarily losing
	 * register — a *spliced* system. Set to `0` to disable.
	 */
	readonly chromaticAberration: number
	/**
	 * Colors wash toward their own luma, `0`..`1`, as a CRT losing chroma sync.
	 * The frame briefly goes monochrome and snaps back. Reads as an *analog*
	 * system, and — unlike aberration — it invents no new hues, so it never
	 * smuggles cool fringes into an all-warm palette. Set to `0` to disable.
	 *
	 * Because it can only pull colour toward gray, a burst carried by dropout alone
	 * reads as "the screen darkened". The injection fields below restore the hue.
	 */
	readonly chromaDropout: number

	/*
	 * -- Injection: PAINT corrupt colour the whole-frame pass cannot produce. --
	 * A burst sometimes stamps solid colour blocks (over the bg, forcing a filled
	 * rectangle — including over the logo and borders) and sometimes replaces a run
	 * of foregrounds with one chosen corrupt hue. Unlike the `color` row-kind, which
	 * smears a *neighbour's* colour, these inject a *chosen* colour.
	 *
	 * Every hue is a theme token (no literal may live outside theme/*). TACTICAL
	 * supplies warm tones + red + grays only — nothing cool; AUGMENTED may add its
	 * teal/purple. `postfx` parses these to RGB once per install, never per frame.
	 */

	/** The palette a burst injects. Empty disables both blocks and tints. */
	readonly corruptColors: readonly string[]
	/** Probability a burst paints solid colour blocks, and the most it paints. */
	readonly blockChance: number
	readonly maxBlocks: number
	/** Probability a burst injects tinted foreground runs, and the most it injects. */
	readonly tintChance: number
	readonly maxTints: number
}

export interface PostFx {
	/** Outer glow. See `hud/GlowEffect.ts` — this is NOT opentui's `BloomEffect`. */
	readonly glow?: { readonly threshold: number; readonly strength: number; readonly radius: number }
	readonly scanlines?: { readonly strength: number; readonly step: number }
	readonly vignette?: number
	readonly crtBar?: {
		readonly speed: number
		readonly height: number
		readonly intensity: number
		readonly fadeDistance: number
	}
	readonly glitch?: GlitchSpec
}

export interface ThemeColors {
	/** The void. UI elements supply all the light in the scene. */
	readonly void: string
	/** Panel fill. Usually `"transparent"` so the void shows through. */
	readonly panel: string
	/** Fill behind a selected/active row. */
	readonly raised: string

	/** THE FOUNDATION — structural baseline: titles, headings, primary readouts. */
	readonly core: string
	readonly coreBright: string
	readonly coreDim: string

	/** AUGMENTATION — cool relief. Borders, structural data, labels, inline code. */
	readonly grid: string
	readonly gridDim: string

	/** AUGMENTATION — "injected" values. Cross-references, highlighted figures. */
	readonly inject: string

	/** CRITICAL — failures and destructive actions. Used sparingly. */
	readonly alert: string

	/** Text hierarchy. */
	readonly text: string
	readonly textDim: string
	readonly textFaint: string
}

export interface ThemeChrome {
	/** Border style for the outer frame. */
	readonly frameStyle: BorderStyle
	/** Border style for inner panels. */
	readonly panelStyle: BorderStyle
	readonly border: string
	readonly title: string
	/** Prefix stamped in front of section headings, e.g. `"// "`. */
	readonly heading: string
}

/** Maps GitHub item states onto palette slots. */
export interface ThemeSemantic {
	readonly open: string
	readonly closed: string
	readonly merged: string
	readonly draft: string
}

export interface Theme {
	readonly name: string
	readonly tagline: string
	readonly color: ThemeColors
	readonly chrome: ThemeChrome
	readonly semantic: ThemeSemantic
	readonly fx: PostFx
	/** Left-to-right partial block ramp used by the horizontal count bars. */
	readonly barRamp: readonly string[]
	/** Bottom-up block ramp used by the activity sparkline. */
	readonly sparkRamp: readonly string[]
}
