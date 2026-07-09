import type { BorderStyle } from '@opentui/core'

export type ThemeId = 'augmented' | 'tactical'

/**
 * One concentric ring of the HUD reticle.
 *
 * `radius` is expressed in terminal *rows*. Cells are roughly twice as tall as
 * they are wide, so the ring renderer multiplies the horizontal component by
 * {@link CELL_ASPECT} to keep circles looking circular.
 */
export interface RingSpec {
	/** Ring radius, in rows. */
	readonly radius: number
	/** Ring stroke color. */
	readonly color: string
	/** Angular velocity in radians/second. Sign selects direction. */
	readonly speed: number
	/** Number of evenly spaced arc segments. `1` with `duty: 1` is a solid ring. */
	readonly segments: number
	/** Fraction of each segment that is actually drawn (0..1). */
	readonly duty: number
	/** Draw short radial tick marks at every segment boundary. */
	readonly ticks?: boolean
	/**
	 * Static start-angle offset, in radians, added to the rotation. Lets a theme
	 * stagger rings so their seams don't all begin aligned, and park a ring's gaps
	 * on the vertical (12/6 o'clock): a terminal cell is 2:1, so a lit arc riding a
	 * cardinal smears into a horizontal run of `─` that reads as a bar rather than
	 * an arc. Defaults to `0`.
	 */
	readonly phase?: number
	/**
	 * Depth plane. `0` = immediate foreground, `1` = far background; values in
	 * between give intermediate planes. Maps to a combination of reduced alpha
	 * (via `fade()`) and — past a threshold — the DIM attribute, and orders
	 * drawing back-to-front so a foreground ring wins a contested cell.
	 * Defaults to `0` (foreground). Supersedes the old two-state `recede` flag.
	 */
	readonly depth?: number
}

/** A sweep head orbiting the reticle rim with a short comet trail behind it. */
export interface SweepSpec {
	readonly color: string
	/** Angular velocity of the head, radians/second. Sign selects orbit direction. */
	readonly speed: number
	/** Number of trailing samples behind the leading edge — the comet's length. */
	readonly trail: number
	/**
	 * How far outside the outer ring rim the head orbits, in design units. Larger
	 * lifts the comet clear of the rings; at small sizes it rounds back onto the rim.
	 */
	readonly rim: number
	/** Leading-arc length, radians, before the trail lengthens it. */
	readonly arc: number
	/** Additional arc length per unit of {@link trail}, radians. */
	readonly arcGain: number
}

export interface GlitchSpec {
	/** Expected number of glitch bursts per second. */
	readonly chancePerSecond: number
	readonly maxLines: number
	readonly maxShift: number
	readonly shiftFlipRatio: number
	readonly colorGlitchChance: number
	readonly minDuration: number
	readonly maxDuration: number
	/**
	 * Chromatic aberration strength applied *only while a burst is active*.
	 * This is what makes the amber/teal/purple layers separate on impact and
	 * snap back, rather than smearing text permanently.
	 */
	readonly chromaticAberration: number
}

export interface PostFx {
	readonly bloom?: { readonly threshold: number; readonly strength: number; readonly radius: number }
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

	/** THE FOUNDATION — structural baseline, dials, wireframes, standard readouts. */
	readonly core: string
	readonly coreBright: string
	readonly coreDim: string

	/** AUGMENTATION — cool relief. Grids, bounding boxes, coordinates. */
	readonly grid: string
	readonly gridDim: string

	/** AUGMENTATION — "injected" processes. Spinners, progress, decryption. */
	readonly inject: string
	readonly injectDim: string

	/** CRITICAL — target locks, failures, destructive actions. Used sparingly. */
	readonly alert: string
	readonly alertDim: string

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

export interface ThemeReticle {
	readonly rings: readonly RingSpec[]
	readonly crosshair: string
	/** Crosshair arm length, in rows. */
	readonly crosshairSpan: number
	/** Color of the four target-lock corner brackets. */
	readonly lock: string
	/**
	 * Motion signature of the target-lock brackets. The lock is the most
	 * eye-catching animated element on screen, so its breathing tempo carries the
	 * theme's whole motion feel — fast and unstable for AUGMENTED, slow and steady
	 * for TACTICAL. The brackets ease in and out just outside the outer ring on a
	 * sine wave.
	 */
	readonly lockPulse: {
		/** Angular frequency of the breathing sine, radians/second. Higher = faster. */
		readonly tempo: number
		/** Peak travel of the brackets between tight and loose, in design units. */
		readonly amplitude: number
		/** Resting gap the brackets hold outside the outer ring, in design units. */
		readonly gap: number
	}
	readonly sweep?: SweepSpec
}

export interface Theme {
	readonly id: ThemeId
	readonly name: string
	readonly tagline: string
	readonly color: ThemeColors
	readonly chrome: ThemeChrome
	readonly semantic: ThemeSemantic
	readonly reticle: ThemeReticle
	readonly fx: PostFx
	/** Frames of the "active process" spinner. */
	readonly spinner: readonly string[]
	/** Charset rained down by the data-stream panel. */
	readonly streamChars: string
	/** Left-to-right partial block ramp used by the telemetry bars. */
	readonly barRamp: readonly string[]
}
