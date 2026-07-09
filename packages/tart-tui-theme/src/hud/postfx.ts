import {
	applyChromaticAberration,
	applyScanlines,
	BloomEffect,
	CRTRollingBarEffect,
	VignetteEffect,
} from '@opentui/core'
import type { CliRenderer, OptimizedBuffer } from '@opentui/core'

import type { GlitchSpec, Theme } from '../theme/types.ts'

export interface FxToggles {
	readonly bloom: boolean
	readonly scanlines: boolean
	readonly glitch: boolean
	/** Vignette + CRT rolling bar. */
	readonly crt: boolean
}

export const ALL_FX_ON: FxToggles = { bloom: true, scanlines: true, glitch: true, crt: true }

type GlitchKind = 'shift' | 'flip' | 'color'
interface ActiveGlitch {
	readonly row: number
	readonly kind: GlitchKind
	readonly amount: number
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

		if (this.spec.chromaticAberration > 0) {
			applyChromaticAberration(buffer, this.spec.chromaticAberration)
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
 * Returns a disposer. Order matters: bloom spreads the glow, then the CRT
 * artifacts land on top of it, then the signal is corrupted.
 */
export function installPostFx(renderer: CliRenderer, theme: Theme, toggles: FxToggles): () => void {
	const passes: ((buffer: OptimizedBuffer, deltaMs: number) => void)[] = []
	const { fx } = theme

	if (fx.bloom && toggles.bloom) {
		const bloom = new BloomEffect(fx.bloom.threshold, fx.bloom.strength, fx.bloom.radius)
		passes.push((buffer) => bloom.apply(buffer))
	}

	if (fx.vignette !== undefined && toggles.crt) {
		const vignette = new VignetteEffect(fx.vignette)
		passes.push((buffer) => vignette.apply(buffer))
	}

	if (fx.scanlines && toggles.scanlines) {
		const { strength, step } = fx.scanlines
		passes.push((buffer) => applyScanlines(buffer, strength, step))
	}

	if (fx.crtBar && toggles.crt) {
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
