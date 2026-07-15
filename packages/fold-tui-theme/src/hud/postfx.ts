import {
	applyChromaticAberration,
	applyScanlines,
	CRTRollingBarEffect,
	parseColor,
	VignetteEffect,
} from '@opentui/core'
import type { CliRenderer, OptimizedBuffer } from '@opentui/core'

import type { GlitchSpec, Theme } from '../theme/types'
import { GlowEffect } from './GlowEffect'

/**
 * Whether the glow lights an emitter's own cell background as well as its
 * neighbours'. Held off: the briefs ask for *outer* glow (light around an
 * element), and self-tinting a glyph's background toward its own colour costs
 * contrast for no halo. Dense text still glows as a mass because neighbouring
 * glyphs light each other; isolated marks keep a crisp black centre. Measured
 * both ways — off is cleaner and keeps the background median luminance near 0.
 */
const GLOW_SELF = false

/**
 * Every pass is independently switchable. A theme *declares* which effects exist
 * (`Theme.fx`); a toggle *permits* them. A pass runs only when both agree.
 *
 * `rollingBar` is deliberately its own switch rather than riding along with the
 * vignette. It is the only pass that animates continuously — it never settles,
 * it forces a render loop, and over a long session it is the one people want
 * gone. Any product embedding this style should treat it as opt-in.
 */
export interface FxToggles {
	readonly glow: boolean
	readonly scanlines: boolean
	readonly glitch: boolean
	readonly vignette: VignetteMode
	/** The scrolling CRT brightness band. Continuous motion — keep it optional. */
	readonly rollingBar: boolean
}

export type VignetteMode = 'off' | 'light' | 'heavy'

export const nextVignetteMode = (mode: VignetteMode): VignetteMode => {
	switch (mode) {
		case 'off':
			return 'light'
		case 'light':
			return 'heavy'
		case 'heavy':
			return 'off'
	}
}

export const vignetteStrength = (strength: number, mode: VignetteMode): number => {
	switch (mode) {
		case 'off':
			return 0
		case 'light':
			return strength * 0.5
		case 'heavy':
			return strength
	}
}

export const ALL_FX_ON: FxToggles = {
	glow: true,
	scanlines: true,
	glitch: true,
	vignette: 'heavy',
	rollingBar: true,
}

type GlitchKind = 'shift' | 'flip' | 'color'
interface ActiveGlitch {
	readonly row: number
	readonly kind: GlitchKind
	readonly amount: number
}

/** An 8-bit RGB triple (0–255), the corrupt-palette colours parsed once. */
interface Rgb {
	readonly r: number
	readonly g: number
	readonly b: number
}

/** A solid colour rectangle painted over the frame during a burst. */
interface ActiveBlock {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
	readonly color: Rgb
}

/** A run of foregrounds recoloured to one injected corrupt hue during a burst. */
interface ActiveTint {
	readonly row: number
	readonly start: number
	readonly length: number
	readonly color: Rgb
}

/** Rec. 601 luma, matching the glow's emitter test. */
const LUMA_R = 0.299
const LUMA_G = 0.587
const LUMA_B = 0.114

/** ASCII space — a painted block is a space over a coloured background (see below). */
const CODE_SPACE = 0x20

/** Painted-block size ranges, in cells: a handful wide, one to three rows tall. */
const BLOCK_W_MIN = 3
const BLOCK_W_MAX = 9
const BLOCK_H_MIN = 1
const BLOCK_H_MAX = 3

/** An injected tint run is at least this long; the rest is random up to width/3. */
const TINT_LEN_MIN = 4

/**
 * Fraction of blocks/tints anchored onto a "structural" glyph (border/bar/HUD
 * symbol) rather than placed freely, so panel borders reliably get mangled. The
 * remainder land anywhere — over body text, over the FOLD logo, over the void.
 */
const STRUCTURAL_BIAS = 0.5

/**
 * The char buffer does **not** hold raw Unicode. opentui pools every non-ASCII
 * glyph — all box-drawing (U+2500–U+257F), block elements, the HUD symbols —
 * behind flag bits: a cell is a bare codepoint for ASCII, `0x80000000 | poolIndex`
 * for a pooled glyph, and `0xC0000000` marks a wide-glyph continuation. So a
 * border cell reads as `0x800100xx`, never `0x25xx`; biasing corruption by
 * codepoint *range* (as one might expect) finds nothing. We instead detect a
 * pooled glyph by its flag: `(char[i] & CHAR_FLAG_MASK) === CHAR_FLAG_POOLED`.
 * Borders dominate the pooled set, so anchoring there is what mangles them.
 */
const CHAR_FLAG_MASK = 0xc0000000
const CHAR_FLAG_POOLED = 0x80000000

/**
 * A CRT losing chroma sync: every color slides toward its own luma, so the frame
 * briefly goes monochrome and then snaps back.
 *
 * The analog counterpart to `applyChromaticAberration`. Both recolor the *whole*
 * frame during a burst — reach that row tearing (only ~2% of a screen's glyphs)
 * can't match. But this pass *removes* color rather than inventing it: it can only
 * slide toward gray, so an all-warm palette never grows the cool fringes an RGB
 * channel split would produce — and, on its own, a burst carried by it reads as a
 * darkening. Injecting colour (blocks/tints, painted *after* this) is what restores
 * the hue; see `GlitchDirector.apply`.
 *
 * Foreground and background both: otherwise the glow halo stays warm around
 * desaturated text and reads as a rendering bug rather than a signal fault.
 */
function applyChromaDropout(buffer: OptimizedBuffer, amount: number): void {
	const { fg, bg } = buffer.buffers
	const cells = buffer.width * buffer.height

	for (const channel of [fg, bg]) {
		for (let i = 0; i < cells; i++) {
			const base = i * 4
			const r = (channel[base] ?? 0) & 0xff
			const g = (channel[base + 1] ?? 0) & 0xff
			const b = (channel[base + 2] ?? 0) & 0xff

			const luma = LUMA_R * r + LUMA_G * g + LUMA_B * b
			channel[base] = r + (luma - r) * amount
			channel[base + 1] = g + (luma - g) * amount
			channel[base + 2] = b + (luma - b) * amount
		}
	}
}

/**
 * Occasional, short glitch bursts.
 *
 * Written rather than reusing `DistortionEffect` for two reasons:
 *
 *  1. `DistortionEffect` treats `deltaTime` as **seconds** while the renderer
 *     hands post-process functions **milliseconds** (`CRTRollingBarEffect`, in
 *     the same library, divides by 1000 itself). Fed ms, its burst timing
 *     degenerates into per-frame static.
 *  2. Chromatic aberration has to be gated on the burst. The brief is that a
 *     system shock *momentarily* separates the color layers and they snap back
 *     — not that text is permanently smeared.
 */
class GlitchDirector {
	private rows: ActiveGlitch[] = []
	private blocks: ActiveBlock[] = []
	private tints: ActiveTint[] = []
	private remaining = 0
	/** The corrupt palette, parsed to 0–255 RGB once at construction. */
	private readonly colors: readonly Rgb[]

	constructor(private readonly spec: GlitchSpec) {
		this.colors = spec.corruptColors.map((hex) => {
			const c = parseColor(hex)
			return { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255) }
		})
	}

	public apply(buffer: OptimizedBuffer, deltaMs: number): void {
		const dt = Math.min(deltaMs, 100) / 1000
		const { width, height } = buffer

		if (this.remaining > 0) {
			this.remaining -= dt
			if (this.remaining <= 0) {
				// Burst over → everything releases, next frame is pristine.
				this.rows = []
				this.blocks = []
				this.tints = []
			}
		} else if (Math.random() < this.spec.chancePerSecond * dt) {
			this.remaining = this.spec.minDuration + Math.random() * (this.spec.maxDuration - this.spec.minDuration)
			this.beginBurst(buffer, width, height)
		}

		if (this.rows.length === 0 && this.blocks.length === 0 && this.tints.length === 0) return

		// ORDER IS LOAD-BEARING. Three stages, and the last one must be the paint:
		//
		//   1. Row corruptions rearrange existing content (shift / flip / smear).
		//   2. The whole-frame pass MOVES or DESATURATES that content (aberration
		//      splits channels; dropout washes toward luma). Both only ever remove
		//      or displace colour — a dropout frame trends toward gray.
		//   3. Blocks and tints INJECT saturated corrupt colour on top.
		//
		// If step 3 ran before step 2, dropout would desaturate the very blocks and
		// tints that are supposed to carry the hue — painting amber then washing it
		// back to gray, i.e. the "screen just darkens" bug. Painting last is what
		// lets the injected colour survive the burst at full saturation. Proven in
		// the probe: injected bg/fg cells read back as the *exact* corrupt hexes,
		// which is impossible if a desaturating pass ran after them.
		for (const glitch of this.rows) this.corruptRow(buffer, glitch, width, height)

		if (this.spec.chromaticAberration > 0) applyChromaticAberration(buffer, this.spec.chromaticAberration)
		if (this.spec.chromaDropout > 0) applyChromaDropout(buffer, this.spec.chromaDropout)

		for (const block of this.blocks) this.paintBlock(buffer, block, width, height)
		for (const tint of this.tints) this.paintTint(buffer, tint, width)
	}

	/** Choose every corruption for this burst once; it then holds for 2–4 frames. */
	private beginBurst(buffer: OptimizedBuffer, width: number, height: number): void {
		this.rows = this.pickRows(height)
		const structural = this.colors.length > 0 ? this.collectStructural(buffer, width, height) : []
		this.blocks = this.pickBlocks(width, height, structural)
		this.tints = this.pickTints(width, height, structural)
	}

	private pickRows(height: number): ActiveGlitch[] {
		const count = 1 + Math.floor(Math.random() * this.spec.maxLines)
		return Array.from({ length: count }, () => {
			const roll = Math.random()
			const kind: GlitchKind =
				roll < this.spec.colorGlitchChance
					? 'color'
					: Math.random() < this.spec.shiftFlipRatio
						? 'shift'
						: 'flip'
			return {
				row: Math.floor(Math.random() * height),
				kind,
				amount: 1 + Math.floor(Math.random() * this.spec.maxShift),
			}
		})
	}

	/**
	 * Flat indices of cells holding a pooled (non-ASCII) glyph — borders, bar
	 * fills, HUD symbols. Scanned once per burst (bursts are rare, so an O(w·h)
	 * pass here is free); used to anchor a share of blocks/tints onto chrome so
	 * borders get hit. See {@link CHAR_FLAG_MASK} for why this is not a range test.
	 */
	private collectStructural(buffer: OptimizedBuffer, width: number, height: number): number[] {
		const { char } = buffer.buffers
		const out: number[] = []
		const total = width * height
		for (let i = 0; i < total; i++) {
			const cp = char[i] ?? 0
			if ((cp & CHAR_FLAG_MASK) >>> 0 === CHAR_FLAG_POOLED) out.push(i)
		}
		return out
	}

	/** A placement point: biased onto a structural cell, else anywhere on screen. */
	private anchor(structural: readonly number[], width: number, height: number): { x: number; y: number } {
		if (structural.length > 0 && Math.random() < STRUCTURAL_BIAS) {
			const idx = structural[Math.floor(Math.random() * structural.length)]
			if (idx !== undefined) return { x: idx % width, y: Math.floor(idx / width) }
		}
		return { x: Math.floor(Math.random() * width), y: Math.floor(Math.random() * height) }
	}

	private randomColor(): Rgb | undefined {
		return this.colors[Math.floor(Math.random() * this.colors.length)]
	}

	private pickBlocks(width: number, height: number, structural: readonly number[]): ActiveBlock[] {
		if (this.colors.length === 0 || Math.random() >= this.spec.blockChance) return []
		const count = 1 + Math.floor(Math.random() * this.spec.maxBlocks)
		const blocks: ActiveBlock[] = []
		for (let k = 0; k < count; k++) {
			const color = this.randomColor()
			if (color === undefined) continue
			const w = BLOCK_W_MIN + Math.floor(Math.random() * (BLOCK_W_MAX - BLOCK_W_MIN + 1))
			const h = BLOCK_H_MIN + Math.floor(Math.random() * (BLOCK_H_MAX - BLOCK_H_MIN + 1))
			const at = this.anchor(structural, width, height)
			const x = Math.max(0, Math.min(at.x - (w >> 1), width - w))
			const y = Math.max(0, Math.min(at.y - (h >> 1), height - h))
			blocks.push({ x, y, w, h, color })
		}
		return blocks
	}

	private pickTints(width: number, height: number, structural: readonly number[]): ActiveTint[] {
		if (this.colors.length === 0 || Math.random() >= this.spec.tintChance) return []
		const count = 1 + Math.floor(Math.random() * this.spec.maxTints)
		const tints: ActiveTint[] = []
		for (let k = 0; k < count; k++) {
			const color = this.randomColor()
			if (color === undefined) continue
			const at = this.anchor(structural, width, height)
			const start = Math.max(0, at.x - Math.floor(Math.random() * TINT_LEN_MIN))
			const length = Math.min(width - start, TINT_LEN_MIN + Math.floor((Math.random() * width) / 3))
			tints.push({ row: at.y, start, length, color })
		}
		return tints
	}

	/**
	 * Stamp a solid rectangle. A pooled `█` can't be synthesised from a raw index
	 * (see {@link CHAR_FLAG_MASK}), so a filled cell is a SPACE over a coloured
	 * background — the terminal paints the whole cell in `bg`. `fg` is set to match
	 * (so any residual ink can't show a stray colour) and attributes are cleared so
	 * no leftover DIM/BOLD mutes it. Alpha is forced opaque so the block is solid.
	 */
	private paintBlock(buffer: OptimizedBuffer, block: ActiveBlock, width: number, height: number): void {
		const { char, fg, bg, attributes } = buffer.buffers
		const { r, g, b } = block.color
		const yEnd = Math.min(block.y + block.h, height)
		const xEnd = Math.min(block.x + block.w, width)
		for (let y = block.y; y < yEnd; y++) {
			for (let x = block.x; x < xEnd; x++) {
				const i = y * width + x
				char[i] = CODE_SPACE
				attributes[i] = 0
				const base = i * 4
				fg[base] = r
				fg[base + 1] = g
				fg[base + 2] = b
				fg[base + 3] = 255
				bg[base] = r
				bg[base + 1] = g
				bg[base + 2] = b
				bg[base + 3] = 255
			}
		}
	}

	/**
	 * Inject one chosen corrupt colour across a run of foregrounds. Chars, bg,
	 * attributes and the fg alpha slot (+3) are left intact, so the underlying
	 * glyphs and borders show through recoloured. Distinct from the `color`
	 * row-kind, which smears a *neighbour's* actual colour rather than a chosen one.
	 */
	private paintTint(buffer: OptimizedBuffer, tint: ActiveTint, width: number): void {
		const { fg } = buffer.buffers
		const { r, g, b } = tint.color
		const base = tint.row * width
		const xEnd = Math.min(tint.start + tint.length, width)
		for (let x = tint.start; x < xEnd; x++) {
			const dst = (base + x) * 4
			fg[dst] = r
			fg[dst + 1] = g
			fg[dst + 2] = b
		}
	}

	private corruptRow(buffer: OptimizedBuffer, glitch: ActiveGlitch, width: number, height: number): void {
		const { row, kind, amount } = glitch
		if (row < 0 || row >= height) return

		const buf = buffer.buffers
		const base = row * width

		if (kind === 'color') {
			// Smear one cell's foreground across a run — the classic datamosh streak.
			const start = Math.floor(Math.random() * width)
			const length = Math.min(width - start, 1 + Math.floor((Math.random() * width) / 3))
			const srcFg = (base + start) * 4
			for (let x = start; x < start + length; x++) {
				const dst = (base + x) * 4
				buf.fg[dst] = buf.fg[srcFg] ?? 0
				buf.fg[dst + 1] = buf.fg[srcFg + 1] ?? 0
				buf.fg[dst + 2] = buf.fg[srcFg + 2] ?? 0
			}
			return
		}

		// Snapshot the row, then rewrite it from the snapshot.
		const char = buf.char.slice(base, base + width)
		const attributes = buf.attributes.slice(base, base + width)
		const fg = buf.fg.slice(base * 4, (base + width) * 4)
		const bg = buf.bg.slice(base * 4, (base + width) * 4)

		for (let x = 0; x < width; x++) {
			const src = kind === 'shift' ? (x - amount + width) % width : width - 1 - x
			const dst = base + x

			buf.char[dst] = char[src] ?? 0
			buf.attributes[dst] = attributes[src] ?? 0
			buf.fg.set(fg.subarray(src * 4, src * 4 + 4), dst * 4)
			buf.bg.set(bg.subarray(src * 4, src * 4 + 4), dst * 4)
		}
	}
}

/**
 * Build the theme's post-processing chain and attach it to the renderer.
 * Returns a disposer.
 *
 * Order matters. The glow lights the background first; the CRT artifacts
 * (vignette, scanlines, rolling bar) then modulate that lit background — which
 * is why scanlines are visible at all on an absolute-black canvas. The glitch
 * corrupts last, so it tears whatever the frame finally looks like.
 */
export function installPostFx(renderer: CliRenderer, theme: Theme, toggles: FxToggles): () => void {
	const passes: ((buffer: OptimizedBuffer, deltaMs: number) => void)[] = []
	const { fx } = theme

	if (fx.glow && toggles.glow) {
		const glow = new GlowEffect(fx.glow.threshold, fx.glow.strength, fx.glow.radius, GLOW_SELF)
		passes.push((buffer) => glow.apply(buffer))
	}

	if (fx.vignette !== undefined && toggles.vignette !== 'off') {
		const vignette = new VignetteEffect(vignetteStrength(fx.vignette, toggles.vignette))
		passes.push((buffer) => vignette.apply(buffer))
	}

	if (fx.scanlines && toggles.scanlines) {
		const { strength, step } = fx.scanlines
		passes.push((buffer) => applyScanlines(buffer, strength, step))
	}

	if (fx.crtBar && toggles.rollingBar) {
		const bar = new CRTRollingBarEffect(
			fx.crtBar.speed,
			fx.crtBar.height,
			fx.crtBar.intensity,
			fx.crtBar.fadeDistance,
		)
		// CRTRollingBarEffect divides deltaTime by 1000 internally — pass raw ms.
		passes.push((buffer, deltaMs) => bar.apply(buffer, deltaMs))
	}

	if (fx.glitch && toggles.glitch) {
		const director = new GlitchDirector(fx.glitch)
		passes.push((buffer, deltaMs) => director.apply(buffer, deltaMs))
	}

	const chain = (buffer: OptimizedBuffer, deltaMs: number): void => {
		for (const pass of passes) pass(buffer, deltaMs)
	}

	renderer.addPostProcessFn(chain)
	return () => renderer.removePostProcessFn(chain)
}
