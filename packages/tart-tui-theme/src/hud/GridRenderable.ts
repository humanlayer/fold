import { OptimizedBuffer, parseColor, Renderable, RGBA, TextAttributes } from '@opentui/core'
import type { RenderableOptions, RenderContext } from '@opentui/core'

import { fade, TRANSPARENT } from './glyphs.ts'

/**
 * How the lattice is drawn.
 *
 * - `nodes` (default): intersection dots only — a sparse dotted lattice with **no
 *   connecting lines**. Brief B: "Dotted grids are used as floor planes or
 *   background textures to establish 3D space." A background texture is dots, not
 *   ruled lines; this is the only mode the app mounts.
 * - `lines`: dotted intersections *plus* faint connecting rules. Brief A's literal
 *   "flat, horizontal plane of teal gridlines" for when ruled lines are wanted.
 *   Kept token-driven and available, but note that over a small panel the rules
 *   flood the box and fight foreground content — prefer `nodes`.
 * - `perspective`: a receding **dotted** floor plane — rows of dots bunching
 *   toward a horizon with the verticals converging on a vanishing point. Draws no
 *   solid near-edge rule (that read as an accidental horizontal border). Brief B:
 *   "floor planes ... to establish 3D space."
 */
export type GridMode = 'nodes' | 'lines' | 'perspective'

export interface GridOptions extends RenderableOptions {
	/** Grid color (theme's `grid` / `gridDim`). Arrives as a string, parsed to RGBA. */
	color: string
	/** How the lattice is drawn. Defaults to `nodes` (dots only). */
	mode?: GridMode
	/** Cells between lattice columns. */
	spacingX?: number
	/** Rows between lattice rows. */
	spacingY?: number
	/** Glyph drawn at each lattice point. Narrow, unambiguous-width only. */
	dot?: string
	/** Rows/sec (flat) or floor-lengths/sec (perspective) the grid scrolls. 0 = static. */
	drift?: number
}

/** Minimum box size, in cells, below which the grid draws nothing rather than something ugly. */
const MIN_WIDTH = 6
const MIN_HEIGHT = 4

/**
 * Lattice dots read faintly; connecting rules (only in `lines` mode) fainter
 * still, so they never read as a border. Both are additionally composited under
 * the DIM attribute, so the on-screen weight is well below these alphas imply —
 * judge density/placement in the monochrome preview and colour weight with
 * `--spans`.
 */
const NODE_ALPHA = 0.5
const LINE_ALPHA = 0.14

type Plot = (x: number, y: number, glyph: string, alpha: number) => void

/**
 * A sparse dotted lattice meant to sit BEHIND panel content as a background
 * texture that establishes 3D space, per both briefs:
 *
 * - Brief A: "secondary structural grids" in electric teal; a "spinning column of
 *   amber text intersected by a flat, horizontal plane of teal gridlines".
 * - Brief B: "Dotted grids are used as floor planes or background textures to
 *   establish 3D space."
 *
 * Draws with a transparent background and the DIM attribute so it composites
 * *under* foreground text and never competes with it. Colours arrive as theme
 * strings; everything is bounds-checked against the box.
 */
export class GridRenderable extends Renderable {
	private _color: RGBA
	private _mode: GridMode
	private _spacingX: number
	private _spacingY: number
	private _dot: string
	private _drift: number
	private elapsed = 0

	constructor(ctx: RenderContext, options: GridOptions) {
		super(ctx, { ...options, live: true })
		this._color = parseColor(options.color)
		this._mode = options.mode ?? 'nodes'
		this._spacingX = atLeast(options.spacingX ?? 6, 2)
		this._spacingY = atLeast(options.spacingY ?? 3, 1)
		this._dot = options.dot ?? '·'
		this._drift = options.drift ?? 0
	}

	// Any prop the reconciler can reassign at runtime (e.g. theme swap) needs a
	// setter, or `instance[key] = value` shadows the private field and it goes stale.
	public set color(next: string) {
		this._color = parseColor(next)
	}

	public set mode(next: GridMode) {
		this._mode = next
	}

	public set spacingX(next: number) {
		this._spacingX = atLeast(next, 2)
	}

	public set spacingY(next: number) {
		this._spacingY = atLeast(next, 1)
	}

	public set dot(next: string) {
		this._dot = next
	}

	public set drift(next: number) {
		this._drift = next
	}

	protected override onUpdate(deltaTime: number): void {
		// deltaTime is milliseconds; keep elapsed in seconds so `drift` is per-second.
		this.elapsed += deltaTime / 1000
	}

	protected override renderSelf(buffer: OptimizedBuffer): void {
		// Degrade to nothing when the box is only a few cells across.
		if (this.width < MIN_WIDTH || this.height < MIN_HEIGHT) return

		const plot: Plot = (px, py, glyph, alpha) => {
			// Never scribble on a sibling panel: bounds-check every write.
			if (px < this.x || px >= this.x + this.width) return
			if (py < this.y || py >= this.y + this.height) return
			buffer.setCellWithAlphaBlending(px, py, glyph, fade(this._color, alpha), TRANSPARENT, TextAttributes.DIM)
		}

		if (this._mode === 'perspective') this.renderPerspective(plot)
		else this.renderFlat(plot, this._mode === 'lines')
	}

	/**
	 * A regular lattice. `nodes` mode plots only the intersection dots; `lines`
	 * mode also draws the faint connecting rules between them. The lattice is
	 * centred on the box when static, so it frames centred content (e.g. the
	 * reticle) symmetrically; when `drift` is set the rows scroll downward instead.
	 */
	private renderFlat(plot: Plot, withLines: boolean): void {
		const spacingX = this._spacingX
		const spacingY = this._spacingY

		// Centre a column on the box's centre cell so the lattice is symmetric.
		const colOffset = mod(Math.round((this.width - 1) / 2), spacingX)
		// Static: centre a row too. Drifting: scroll from the top, wrapped into a period.
		const drifting = this._drift !== 0
		const rowOffset = drifting ? 0 : mod(Math.round((this.height - 1) / 2), spacingY)
		const shift = drifting ? mod(this.elapsed * this._drift, spacingY) : 0

		for (let ry = 0; ry < this.height; ry++) {
			const onH = mod(ry - rowOffset + shift, spacingY) < 1
			for (let cx = 0; cx < this.width; cx++) {
				const onV = mod(cx - colOffset, spacingX) === 0
				if (onH && onV) plot(this.x + cx, this.y + ry, this._dot, NODE_ALPHA)
				else if (withLines && (onH || onV)) plot(this.x + cx, this.y + ry, this._dot, LINE_ALPHA)
			}
		}
	}

	/**
	 * A floor plane receding to a horizon, drawn as **dots only**: node rows bunch
	 * toward the top (far) and spread toward the bottom (near), while the columns
	 * converge on a central vanishing point. Deliberately draws no solid horizontal
	 * rule between the edges — a filled near line reads as an accidental border, not
	 * a floor. `drift` scrolls the floor toward the viewer.
	 */
	private renderPerspective(plot: Plot): void {
		const horizonY = this.y + Math.round(this.height * 0.2)
		const bottomY = this.y + this.height - 1
		const depthSpan = bottomY - horizonY
		if (depthSpan < 2) return

		const vx = this.x + (this.width - 1) / 2
		const halfWidth = (this.width - 1) / 2

		// Number of receding depth rows and converging columns, derived from spacing.
		const rows = clampInt(Math.round(depthSpan / this._spacingY) + 2, 3, 48)
		const cols = clampInt(Math.round(this.width / this._spacingX), 2, 24)

		const phase = this._drift === 0 ? 0 : mod(this.elapsed * this._drift, 1)

		for (let i = 0; i < rows; i++) {
			// t in (0,1]: 0 at the horizon, 1 at the near edge. Squaring bunches rows
			// toward the horizon, which is what makes it read as depth.
			const t = (i + phase) / rows
			const z = t * t
			const ry = Math.round(horizonY + depthSpan * z)
			if (ry < this.y || ry > bottomY) continue

			// Nearer rows are wider and a touch brighter than the far, faint ones.
			const halfSpan = halfWidth * z
			const nodeAlpha = NODE_ALPHA * (0.35 + 0.65 * z)

			// Dots where the converging columns cross this depth row — no filled rule.
			for (let k = 0; k <= cols; k++) {
				const fx = vx + ((k / cols) * 2 - 1) * halfSpan
				plot(Math.round(fx), ry, this._dot, nodeAlpha)
			}
		}
	}
}

/** Clamp a value to a minimum, coercing NaN/undefined to that minimum. */
function atLeast(value: number, min: number): number {
	return Number.isFinite(value) && value > min ? value : min
}

function clampInt(value: number, min: number, max: number): number {
	const v = Math.round(value)
	return v < min ? min : v > max ? max : v
}

/** Positive modulo — JS `%` keeps the sign of the dividend. */
function mod(value: number, m: number): number {
	return ((value % m) + m) % m
}
