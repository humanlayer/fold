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
	 * Whole-frame color corruption, applied *only while a burst is active*.
	 *
	 * Row tearing alone disturbs ~2% of the screen's glyphs — measurably present,
	 * perceptually almost nothing. Practically all of a glitch's punch comes from
	 * one of these two passes, which recolor the whole frame for two to four
	 * frames and then snap back. A theme should pick exactly one: they are the
	 * signature of *what kind of machine is failing*.
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
	 */
	readonly chromaDropout: number
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
