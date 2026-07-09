import { OptimizedBuffer, parseColor, Renderable, RGBA, TextAttributes } from '@opentui/core'
import type { RenderableOptions, RenderContext } from '@opentui/core'

import type { RingSpec, ThemeReticle } from '../theme/types.ts'
import { CELL_ASPECT, fade, litArc, LOCK_CORNERS, ringGlyph, TAU, tickGlyph, TRANSPARENT } from './glyphs.ts'

export interface ReticleOptions extends RenderableOptions {
	spec: ThemeReticle
}

/** Headroom outside the largest ring, in design units, reserved for the lock brackets. */
const LOCK_PAD = 2
/** A ring smaller than this (in rows) is unreadable as a circle — drop it. */
const MIN_RING_ROWS = 2.2
/** Adjacent rings closer than this (in rows) merge into a smudge — drop the inner one. */
const MIN_RING_GAP = 1.6
/** Each lit arc keeps at least this many cells on screen, or its segments are thinned. */
const MIN_ARC_CELLS = 2.5
/** Ticks only ride the outer ring once it is at least this tall — otherwise they crowd the lock. */
const TICK_MIN_ROWS = 7
/** Below this outer radius (rows) the sweep head is dropped rather than rendered as a stub. */
const SWEEP_MIN_ROWS = 3
/** Keep the lock brackets at least this many cells clear of the box edge. */
const LOCK_MARGIN = 1

/** Alpha a far ring (`depth: 1`) keeps: `1 - DEPTH_FADE`. Foreground keeps full alpha. */
const DEPTH_FADE = 0.55
/** Rings at or past this depth also render with the DIM attribute. */
const DEPTH_DIM_AT = 0.5

type Plot = (x: number, y: number, glyph: string, color: RGBA, attributes?: number) => void

/**
 * A ring with everything static about it precomputed, so the 30fps render path
 * touches no `parseColor` and allocates no sort/Set. Built once per `spec` in
 * {@link ReticleRenderable.rebuild}.
 */
interface RingDraw {
	readonly ring: RingSpec
	/** `ring.color` parsed once and pre-faded by `ring.depth`. */
	readonly color: RGBA
	/** DIM if the ring is deep enough, else 0. */
	readonly attributes: number
	/** Depth plane (0 front .. 1 back), cached for draw ordering. */
	readonly depth: number
	/** Rewritten every frame by {@link ReticleRenderable.planRings}: survives the fit? */
	keep: boolean
}

/**
 * Nested concentric rings rotating on independent axes at different speeds and
 * directions, a sweep head riding the outer rim, a crosshair, and four pulsing
 * target-lock brackets.
 *
 * Ring radii in {@link ThemeReticle} are *design units*, not cells: the
 * renderable scales them to whatever box it lands in, so a theme reads the same
 * in a 32-column rail as it does full-screen. When the box is small the reticle
 * degrades gracefully — rings that would collapse into their neighbours or the
 * crosshair are dropped, segmented arcs are thinned so they keep a legible arc
 * length, and ticks/sweep fall away below a size threshold.
 *
 * Runs `live`, so the renderer calls `onUpdate` every frame and there is no
 * need to call `requestRender()` from it.
 */
export class ReticleRenderable extends Renderable {
	private _spec: ThemeReticle
	private elapsed = 0

	// Caches, rebuilt only when `spec` changes — never touched by the render loop.
	/** Draw order: far (high depth) first, so the foreground overwrites shared cells. */
	private _drawOrder: RingDraw[] = []
	/** Same RingDraws, largest-radius first, for the graceful-drop planner. */
	private _byRadius: RingDraw[] = []
	private _crosshairColor: RGBA = TRANSPARENT
	private _lockColor: RGBA = TRANSPARENT
	private _sweepColor: RGBA | null = null
	/** Reused every frame so the sweep-trail dedupe allocates no Set per frame. */
	private readonly _sweepClaimed = new Set<number>()

	constructor(ctx: RenderContext, options: ReticleOptions) {
		super(ctx, { ...options, live: true })
		this._spec = options.spec
		this.rebuild()
	}

	/**
	 * Reassigned by the reconciler when the theme changes. The setter must stay:
	 * `createInstance` writes prop updates via `instance.spec = value`, and without
	 * it the private field would go stale. Rebuilds the per-spec caches so the hot
	 * render path never re-parses colors or re-sorts rings.
	 */
	public set spec(next: ThemeReticle) {
		this._spec = next
		this.rebuild()
		this.requestRender()
	}

	public get spec(): ThemeReticle {
		return this._spec
	}

	/**
	 * Recompute the per-spec caches: parse every color once, pre-fade each ring by
	 * its depth, resolve its DIM attribute, and pre-sort both the back-to-front
	 * draw order and the largest-first fit order. Called from the constructor and
	 * the `spec` setter only.
	 */
	private rebuild(): void {
		const draws: RingDraw[] = this._spec.rings.map((ring) => {
			const depth = ring.depth ?? 0
			const alpha = 1 - depth * DEPTH_FADE
			return {
				ring,
				color: fade(parseColor(ring.color), alpha),
				attributes: depth >= DEPTH_DIM_AT ? TextAttributes.DIM : 0,
				depth,
				keep: false,
			}
		})
		// Back-to-front: far rings first, foreground last, so a foreground ring
		// overwrites (wins) any cell a background ring also claimed.
		this._drawOrder = [...draws].sort((a, b) => b.depth - a.depth)
		// Largest radius first for the graceful ring-drop planner.
		this._byRadius = [...draws].sort((a, b) => b.ring.radius - a.ring.radius)
		this._crosshairColor = parseColor(this._spec.crosshair)
		this._lockColor = parseColor(this._spec.lock)
		this._sweepColor = this._spec.sweep ? parseColor(this._spec.sweep.color) : null
	}

	protected override onUpdate(deltaTime: number): void {
		this.elapsed += deltaTime / 1000
	}

	/** Largest ring radius, in design units. */
	private get designRadius(): number {
		let max = 0
		for (const ring of this._spec.rings) max = Math.max(max, ring.radius)
		return max || 4
	}

	/** Design units -> rows, fitted to the current box. */
	private get scale(): number {
		const halfRows = (this.height - 1) / 2
		const halfCols = (this.width - 1) / (2 * CELL_ASPECT)
		return Math.min(halfRows, halfCols) / (this.designRadius + LOCK_PAD)
	}

	protected override renderSelf(buffer: OptimizedBuffer): void {
		if (this.width < 8 || this.height < 5) return

		const cx = this.x + (this.width - 1) / 2
		const cy = this.y + (this.height - 1) / 2
		const scale = this.scale

		// Never let a ring escape its own box and scribble on a sibling panel.
		const plot: Plot = (px, py, glyph, color, attributes = 0) => {
			if (px < this.x || px >= this.x + this.width) return
			if (py < this.y || py >= this.y + this.height) return
			buffer.setCellWithAlphaBlending(px, py, glyph, color, TRANSPARENT, attributes)
		}

		// Decide which rings survive at this scale before drawing anything, so the
		// crosshair can size itself to the innermost ring that actually renders.
		const innerRows = this.planRings(scale)

		// Back-to-front (far depth first), so a foreground ring wins any shared cell.
		for (const draw of this._drawOrder) if (draw.keep) this.drawRing(plot, cx, cy, draw, scale)

		// The sweep rides the outer rim on top of the rings, so it reads as a bright
		// head orbiting the dial — and shows through the ring's own segment gaps.
		this.drawSweep(plot, cx, cy, scale)

		this.drawCrosshair(plot, cx, cy, innerRows)
		this.drawLock(plot, cx, cy, scale)
	}

	/**
	 * Mark which rings survive at the current scale and return the innermost kept
	 * radius (rows), which the crosshair uses to avoid colliding with it.
	 *
	 * Walks the cached largest-first order and writes each ring's `keep` flag in
	 * place — no array copy or Set allocated per frame. A ring is kept only if it
	 * is tall enough to read as a circle and far enough from the last ring kept.
	 */
	private planRings(scale: number): number {
		let lastRows = Number.POSITIVE_INFINITY
		let innerRows = 0
		for (const draw of this._byRadius) {
			const rows = draw.ring.radius * scale
			const keep = rows >= MIN_RING_ROWS && lastRows - rows >= MIN_RING_GAP
			draw.keep = keep
			if (!keep) continue
			lastRows = rows
			innerRows = rows
		}
		return innerRows
	}

	private drawRing(plot: Plot, cx: number, cy: number, draw: RingDraw, scale: number): void {
		const ring = draw.ring
		const radius = ring.radius * scale
		if (radius < 1) return

		const color = draw.color
		const attributes = draw.attributes
		// Static `phase` staggers rings and parks gaps on the cardinals; the spin adds on top.
		const phase = this.elapsed * ring.speed + (ring.phase ?? 0)
		const segments = this.fitSegments(ring.segments, ring.duty, radius)

		// Sample densely enough that consecutive samples land on adjacent cells.
		const steps = Math.max(24, Math.ceil(TAU * radius * CELL_ASPECT * 1.5))

		for (let i = 0; i < steps; i++) {
			const theta = (i / steps) * TAU
			if (!litArc(theta, phase, segments, ring.duty)) continue
			plot(
				Math.round(cx + CELL_ASPECT * radius * Math.cos(theta)),
				Math.round(cy + radius * Math.sin(theta)),
				ringGlyph(theta),
				color,
				attributes,
			)
		}

		// Ticks only make sense on a ring large enough to hold them clear of the lock.
		if (!ring.ticks || segments <= 0 || radius < TICK_MIN_ROWS) return

		// Graduations sit just *inside* the rim: an outward tick at the top/bottom
		// floats a lone glyph up against the lock brackets, whereas an inward notch
		// reads as attached to the dial and stays clear of everything else.
		const tickRadius = radius - 1
		for (let s = 0; s < segments; s++) {
			const theta = phase + (s / segments) * TAU
			plot(
				Math.round(cx + CELL_ASPECT * tickRadius * Math.cos(theta)),
				Math.round(cy + tickRadius * Math.sin(theta)),
				tickGlyph(theta),
				color,
				attributes,
			)
		}
	}

	/**
	 * Thin a ring's segment count so each lit arc keeps at least {@link MIN_ARC_CELLS}
	 * cells on screen. At small scaled radii the theme's segment count would slice the
	 * ring into 1–2 cell dashes that read as dirt; fewer, longer arcs stay legible.
	 */
	private fitSegments(segments: number, duty: number, radius: number): number {
		if (segments <= 1) return segments
		// Rough on-screen perimeter in cells (ellipse, semi-axes CELL_ASPECT*r and r).
		const perimCells = (TAU * radius * (CELL_ASPECT + 1)) / 2
		const maxSegments = Math.floor((perimCells * duty) / MIN_ARC_CELLS)
		return Math.max(1, Math.min(segments, maxSegments))
	}

	/**
	 * A sweep head riding the outer rim with a short comet trail behind it.
	 *
	 * Deliberately *not* a full-radius radar spoke: a line from the hub to the rim
	 * renders as a long horizontal run whenever it points sideways, and several
	 * trail copies of it turn the interior into dashed noise. Riding the rim as a
	 * tangential comet keeps the nested-ring parallax — the actual point of the
	 * reticle — legible, and the head still shows through the outer ring's gaps.
	 */
	private drawSweep(plot: Plot, cx: number, cy: number, scale: number): void {
		const sweep = this._spec.sweep
		const color = this._sweepColor
		if (!sweep || !color) return

		// Ride the empty annulus just outside the rim (ticks now point inward). The
		// `rim` offset is in design units, so at full scale the head is a distinct
		// orbiting dot and at the rail size it rounds back onto the rim — never onto
		// the lock, whose brackets only occupy the four diagonal corners.
		const rimRadius = (this.designRadius + sweep.rim) * scale
		if (this.designRadius * scale < SWEEP_MIN_ROWS) return

		const head = this.elapsed * sweep.speed

		// A tight arc — a bright head with a short tail — grown from theme tokens
		// (`arc` + `trail` * `arcGain`), so it reads as one orbiting dot rather than a
		// fan of spokes or a long streak that competes with the rings.
		const arc = sweep.arc + sweep.trail * sweep.arcGain
		const steps = Math.max(6, Math.ceil(arc * rimRadius * CELL_ASPECT * 1.5))

		const claimed = this._sweepClaimed
		claimed.clear()
		for (let i = 0; i <= steps; i++) {
			const t = i / steps
			const theta = head - t * arc
			const px = Math.round(cx + CELL_ASPECT * rimRadius * Math.cos(theta))
			const py = Math.round(cy + rimRadius * Math.sin(theta))
			const key = py * 4096 + px
			if (claimed.has(key)) continue
			claimed.add(key)
			const alpha = (1 - t) * (1 - t)
			const attributes = i === 0 ? 0 : t > 0.5 ? TextAttributes.DIM : 0
			plot(px, py, ringGlyph(theta), fade(color, alpha), attributes)
		}
	}

	private drawCrosshair(plot: Plot, cx: number, cy: number, innerRows: number): void {
		const color = this._crosshairColor

		// Shrink the crosshair so its arms stay clear of the innermost ring that
		// actually rendered; at the rail size a full-length crosshair collides with it.
		let span = this._spec.crosshairSpan
		if (innerRows > 0) span = Math.min(span, Math.max(1, Math.floor(innerRows - MIN_RING_GAP)))

		const x0 = Math.round(cx)
		const y0 = Math.round(cy)

		// Arms are contiguous. The horizontal arm is twice as long in cells so that
		// both arms read the same physical length on screen.
		for (let i = 1; i <= span * CELL_ASPECT; i++) {
			plot(x0 - i, y0, '─', color)
			plot(x0 + i, y0, '─', color)
		}
		for (let i = 1; i <= span; i++) {
			plot(x0, y0 - i, '│', color)
			plot(x0, y0 + i, '│', color)
		}
		plot(x0, y0, '┼', color)
	}

	private drawLock(plot: Plot, cx: number, cy: number, scale: number): void {
		const color = this._lockColor

		// Breathe: the lock tightens and releases just outside the outer ring. The
		// tempo/amplitude/gap are theme tokens — this is the theme's motion signature
		// (fast + unstable vs. slow + steady), the most eye-catching element on screen.
		const { tempo, amplitude, gap } = this._spec.lockPulse
		const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * tempo)
		const lockRows = (this.designRadius + gap + pulse * amplitude) * scale

		const x0 = Math.round(cx)
		const y0 = Math.round(cy)

		// Clamp each half-extent so all four brackets stay fully inside the box, whatever
		// the pulse or box size — the bounds check would otherwise silently drop a corner.
		const maxRx = Math.min(x0 - this.x, this.x + this.width - 1 - x0) - LOCK_MARGIN
		const maxRy = Math.min(y0 - this.y, this.y + this.height - 1 - y0) - LOCK_MARGIN
		if (maxRx < 1 || maxRy < 1) return

		const rx = Math.min(Math.round(lockRows * CELL_ASPECT), maxRx)
		const ry = Math.min(Math.round(lockRows), maxRy)

		// LOCK_CORNERS is a fixed 4-tuple (┌ ┐ └ ┘); inline the corners so no array
		// is allocated per frame. `plot` bounds-checks each write.
		plot(x0 - rx, y0 - ry, LOCK_CORNERS[0], color)
		plot(x0 + rx, y0 - ry, LOCK_CORNERS[1], color)
		plot(x0 - rx, y0 + ry, LOCK_CORNERS[2], color)
		plot(x0 + rx, y0 + ry, LOCK_CORNERS[3], color)
	}
}
