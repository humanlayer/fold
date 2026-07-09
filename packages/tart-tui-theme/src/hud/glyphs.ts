import { RGBA } from '@opentui/core'

/**
 * Terminal cells are roughly twice as tall as they are wide. Multiply every
 * horizontal component by this to make circles look circular.
 */
export const CELL_ASPECT = 2

export const TAU = Math.PI * 2

/**
 * Pick a box-drawing glyph matching the local tangent of a circle at angle
 * `theta`.
 *
 * For a point `(cx + a*r*cos t, cy + r*sin t)` the tangent vector is
 * `(-a*r*sin t, r*cos t)`. Screen `y` grows downward, so a positive slope is a
 * line falling to the right: `╲`.
 */
export function ringGlyph(theta: number): string {
	const tx = -CELL_ASPECT * Math.sin(theta)
	const ty = Math.cos(theta)

	if (Math.abs(tx) < 1e-6) return '│'
	const slope = ty / tx
	const steep = Math.abs(slope)

	if (steep < 0.35) return '─'
	if (steep > 1.8) return '│'
	return slope > 0 ? '╲' : '╱'
}

/** Radial tick glyph, oriented outward from the center. */
export function tickGlyph(theta: number): string {
	const rx = CELL_ASPECT * Math.cos(theta)
	const ry = Math.sin(theta)
	if (Math.abs(rx) < 1e-6) return '│'
	const slope = ry / rx
	const steep = Math.abs(slope)
	if (steep < 0.35) return '─'
	if (steep > 1.8) return '│'
	return slope > 0 ? '╲' : '╱'
}

/** Scale a color's RGB toward black. Alpha is preserved. */
export function shade(color: RGBA, factor: number): RGBA {
	return RGBA.fromValues(color.r * factor, color.g * factor, color.b * factor, color.a)
}

/** Scale a color's alpha. Used for the sweep trail falloff. */
export function fade(color: RGBA, alpha: number): RGBA {
	return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

/**
 * Is `theta` inside a lit arc?
 *
 * The circle is divided into `segments` wedges; the first `duty` fraction of
 * each wedge is drawn. `phase` rotates the whole pattern.
 */
export function litArc(theta: number, phase: number, segments: number, duty: number): boolean {
	if (segments <= 0) return true
	if (duty >= 1) return true
	const wedge = TAU / segments
	// `%` keeps the sign of the dividend in JS, so normalize into [0, wedge).
	const local = (((theta - phase) % wedge) + wedge) % wedge
	return local < wedge * duty
}

/** Corner brackets of a target lock: `┌ ┐ └ ┘` at the box corners. */
export const LOCK_CORNERS = ['┌', '┐', '└', '┘'] as const

export const TRANSPARENT: RGBA = RGBA.fromValues(0, 0, 0, 0)

/** Deterministic pseudo-random in [0, 1) — stable per (seed) across frames. */
export function hash01(seed: number): number {
	const x = Math.sin(seed * 12.9898) * 43758.5453
	return x - Math.floor(x)
}
