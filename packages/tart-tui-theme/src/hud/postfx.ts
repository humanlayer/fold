import { applyChromaticAberration, applyScanlines, CRTRollingBarEffect, VignetteEffect } from '@opentui/core'
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
	readonly vignette: boolean
	/** The scrolling CRT brightness band. Continuous motion — keep it optional. */
	readonly rollingBar: boolean
}

export const ALL_FX_ON: FxToggles = {
	glow: true,
	scanlines: true,
	glitch: true,
	vignette: true,
	rollingBar: true,
}

type GlitchKind = 'shift' | 'flip' | 'color'
interface ActiveGlitch {
	readonly row: number
	readonly kind: GlitchKind
	readonly amount: number
}

/** Rec. 601 luma, matching the glow's emitter test. */
const LUMA_R = 0.299
const LUMA_G = 0.587
const LUMA_B = 0.114

/**
 * A CRT losing chroma sync: every color slides toward its own luma, so the frame
 * briefly goes monochrome and then snaps back.
 *
 * The analog counterpart to `applyChromaticAberration`. Both recolor the *whole*
 * frame during a burst, and that reach is where a glitch gets its punch — row
 * tearing on its own disturbs only ~2% of a screen's glyphs. But this pass
 * *removes* color rather than inventing it, so an all-warm palette never grows
 * the cool fringes an RGB channel split would produce.
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
	private active: ActiveGlitch[] = []
	private remaining = 0

	constructor(private readonly spec: GlitchSpec) {}

	public apply(buffer: OptimizedBuffer, deltaMs: number): void {
		const dt = Math.min(deltaMs, 100) / 1000
		const { width, height } = buffer

		if (this.remaining > 0) {
			this.remaining -= dt
			if (this.remaining <= 0) this.active = []
		} else if (Math.random() < this.spec.chancePerSecond * dt) {
			this.remaining = this.spec.minDuration + Math.random() * (this.spec.maxDuration - this.spec.minDuration)
			this.active = this.pick(height)
		}

		if (this.active.length === 0) return

		for (const glitch of this.active) this.corruptRow(buffer, glitch, width, height)

		// Whole-frame color corruption. A theme picks one idiom or neither.
		if (this.spec.chromaticAberration > 0) {
			applyChromaticAberration(buffer, this.spec.chromaticAberration)
		}
		if (this.spec.chromaDropout > 0) {
			applyChromaDropout(buffer, this.spec.chromaDropout)
		}
	}

	private pick(height: number): ActiveGlitch[] {
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

	if (fx.vignette !== undefined && toggles.vignette) {
		const vignette = new VignetteEffect(fx.vignette)
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
