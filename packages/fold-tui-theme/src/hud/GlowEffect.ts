import type { OptimizedBuffer } from '@opentui/core'

/**
 * Terminal cells are roughly twice as tall as they are wide, so a kernel that is
 * circular in cell space renders as a vertical ellipse.
 */
const CELL_ASPECT = 2

/**
 * Rec. 601 luma weights. Every luminance test in the FX chain (opentui's
 * `BloomEffect`, `applyAsciiArt`) uses these, so "does this token cross the glow
 * threshold" reads the same everywhere.
 */
const LUMA_R = 0.299
const LUMA_G = 0.587
const LUMA_B = 0.114

/** Codepoints that are not real glyphs and must never emit. */
const CODE_UNSET = 0
const CODE_SPACE = 32

function clamp01(value: number): number {
	if (value < 0) return 0
	if (value > 1) return 1
	return value
}

/**
 * Glyph-aware **outer glow**.
 *
 * This replaces opentui's `BloomEffect`, whose emitter test is
 * `lum(fg) or lum(bg) > threshold` — it never looks at the cell's *character*.
 * A blank cell still carries a foreground colour, and the default foreground is
 * white (luminance 1.0), so on a HUD that is mostly empty cells over a black
 * void **every empty cell becomes a maximum-intensity emitter** and the glow is
 * dumped uniformly across the whole screen. `threshold` then does nothing (the
 * white blanks emit at every threshold below 1.0) and the amber/teal/purple
 * palette is buried under a flat white wash.
 *
 * `GlowEffect` fixes this with three rules:
 *
 *  1. **Only real glyphs emit.** We read `buffers.char` and skip space / unset.
 *     This alone kills the void-glow, and makes `threshold` genuinely mean
 *     "how bright must a glyph be to glow".
 *  2. **The emitter's own foreground luminance** (never the background) decides
 *     intensity, normalised `(lum - threshold) / (1 - threshold)`.
 *  3. **The glow lands on the BACKGROUND of neighbours**, tinted toward the
 *     emitter's foreground colour, additively, with distance falloff, clamped.
 *     The foreground buffer is **never touched**, so glyph colours survive
 *     exactly — that is what preserves the palette, and what "outer glow" means:
 *     light *around* an element, not smeared over it.
 *
 * Performance: a single in-place pass, no per-emitter allocation and no copy of
 * the fg/bg buffers. `BloomEffect` must copy both buffers every frame because it
 * *writes* fg while its emitter test *reads* fg; our emitter test reads only
 * `char` + `fg` (both untouched) and writes only `bg`, so accumulating straight
 * into the live background is order-independent and correct. The only retained
 * scratch is the falloff kernel, allocated once and rebuilt solely when `radius`
 * changes.
 */
export class GlowEffect {
	private readonly threshold: number
	private readonly strength: number
	private readonly radius: number
	/**
	 * Whether an emitter also lights its **own** cell background. Off by default:
	 * an outer glow belongs around a glyph, and tinting a glyph's own background
	 * toward its own colour lowers its contrast against itself. Dense text still
	 * reads as a glowing mass because adjacent glyphs light *each other's* cells;
	 * only a truly isolated mark keeps a clean black centre inside its halo.
	 */
	private readonly glowSelf: boolean

	/**
	 * Falloff weights over the neighbourhood, row-major. Allocated once and rebuilt
	 * only when `radius` changes — never per frame.
	 */
	private kernel: Float64Array = new Float64Array(0)
	private kernelRadius = -1
	/** Horizontal extent, in cells. See {@link ensureKernel}. */
	private radiusX = 0

	constructor(threshold = 0.8, strength = 0.2, radius = 2, glowSelf = false) {
		this.threshold = clamp01(threshold)
		this.strength = Math.max(0, strength)
		this.radius = Math.max(0, Math.round(radius))
		this.glowSelf = glowSelf
	}

	/**
	 * Build the falloff kernel.
	 *
	 * `radius` is expressed in **rows**. Terminal cells are about twice as tall as
	 * they are wide, so a kernel that is circular in cell space renders as a
	 * vertical ellipse — every halo smears upward and downward. Measure distance
	 * in screen units instead (a row step counts {@link CELL_ASPECT} times a column
	 * step) and let the kernel run `radius * CELL_ASPECT` cells wide. The halo then
	 * reads as a circle.
	 *
	 * Falloff reaches zero one ring *past* the outer ring (`radius + 1`), so the
	 * outermost neighbours still receive light. opentui's `1 - dist/radius` gives
	 * its outer ring exactly zero, which is why it needs a larger radius to show
	 * anything at all.
	 */
	private ensureKernel(): void {
		if (this.kernelRadius === this.radius) return
		const ry = this.radius
		const rx = ry * CELL_ASPECT
		const dim = 2 * rx + 1
		const kernel = new Float64Array(dim * (2 * ry + 1))
		const reach = CELL_ASPECT * (ry + 1)

		for (let ky = -ry; ky <= ry; ky++) {
			for (let kx = -rx; kx <= rx; kx++) {
				const dy = CELL_ASPECT * ky
				const dist = Math.sqrt(kx * kx + dy * dy)
				const weight = 1 - dist / reach
				kernel[(ky + ry) * dim + (kx + rx)] = weight > 0 ? weight : 0
			}
		}
		this.kernel = kernel
		this.kernelRadius = ry
		this.radiusX = rx
	}

	public apply(buffer: OptimizedBuffer): void {
		const { threshold, strength, radius, glowSelf } = this
		if (strength <= 0 || radius <= 0) return

		this.ensureKernel()

		const width = buffer.width
		const height = buffer.height
		const { char, fg, bg } = buffer.buffers
		const kernel = this.kernel
		const radiusX = this.radiusX
		const dim = 2 * radiusX + 1
		// Guard the normaliser against threshold == 1 (division by zero).
		const denom = 1 - threshold > 1e-6 ? 1 - threshold : 1e-6

		for (let y = 0; y < height; y++) {
			const rowStart = y * width
			for (let x = 0; x < width; x++) {
				const i = rowStart + x
				const code = char[i] ?? CODE_UNSET
				// Rule 1: only real glyphs emit. Blank/unset cells carry a (usually
				// white) foreground but draw nothing, so they must never glow.
				if (code === CODE_UNSET || code === CODE_SPACE) continue

				const base = i * 4
				const fr = (fg[base] ?? 0) & 0xff
				const fgc = (fg[base + 1] ?? 0) & 0xff
				const fb = (fg[base + 2] ?? 0) & 0xff

				// Rule 2: intensity from the glyph's own foreground luminance.
				const lum = (LUMA_R * fr + LUMA_G * fgc + LUMA_B * fb) / 255
				if (lum <= threshold) continue

				const emit = ((lum - threshold) / denom) * strength
				// Pre-scale the emitter colour (0..255) by intensity once, so the
				// inner loop is a multiply-add per channel.
				const er = fr * emit
				const eg = fgc * emit
				const eb = fb * emit

				// Clamp the neighbourhood to the buffer so the inner loop is
				// branch-light and never touches a foreign row/column.
				const kyLo = y - radius < 0 ? -y : -radius
				const kyHi = y + radius >= height ? height - 1 - y : radius
				const kxLo = x - radiusX < 0 ? -x : -radiusX
				const kxHi = x + radiusX >= width ? width - 1 - x : radiusX

				for (let ky = kyLo; ky <= kyHi; ky++) {
					const nRow = (y + ky) * width
					const kRow = (ky + radius) * dim + radiusX
					for (let kx = kxLo; kx <= kxHi; kx++) {
						if (!glowSelf && kx === 0 && ky === 0) continue
						const weight = kernel[kRow + kx] ?? 0
						if (weight <= 0) continue

						// Rule 3: additive tint of the neighbour BACKGROUND toward the
						// emitter's foreground colour. fg is never written, so glyph
						// colours are preserved exactly. Alpha (slot +3) is preserved.
						const nb = (nRow + (x + kx)) * 4
						const r = ((bg[nb] ?? 0) & 0xff) + er * weight
						const g = ((bg[nb + 1] ?? 0) & 0xff) + eg * weight
						const b = ((bg[nb + 2] ?? 0) & 0xff) + eb * weight
						bg[nb] = r > 255 ? 255 : r
						bg[nb + 1] = g > 255 ? 255 : g
						bg[nb + 2] = b > 255 ? 255 : b
					}
				}
			}
		}
	}
}
