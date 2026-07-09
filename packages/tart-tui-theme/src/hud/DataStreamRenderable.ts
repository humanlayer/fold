import { OptimizedBuffer, parseColor, Renderable, RGBA, TextAttributes } from '@opentui/core'
import type { RenderableOptions, RenderContext } from '@opentui/core'

import { fade, hash01, TRANSPARENT } from './glyphs.ts'

export interface DataStreamOptions extends RenderableOptions {
	/** Charset rained down the columns. Narrow glyphs only. */
	chars: string
	/** Color of the leading character of each column. */
	head: string
	/** Color the tail fades toward. */
	trail: string
	/**
	 * Fraction of columns (0..1) that rain a coherent technical token — a fake
	 * file path, hex address, or tagged readout — instead of pure random glyphs,
	 * so the field reads as "data" rather than static. Defaults to 0.45.
	 */
	tokenRatio?: number
}

interface Column {
	/** Fractional row of the leading character. */
	y: number
	/** Rows per second. */
	speed: number
	/** Tail length in rows. */
	length: number
	seed: number
	/**
	 * When set, the column renders this technical token as a vertical readout
	 * (indexed by row) instead of flickering random glyphs. The bright head then
	 * scans down a stable string, reading as a file path / address dump.
	 */
	token: string | null
}

/**
 * Cascading code overlay — the "injected" data stream that bypasses the
 * standard amber system. Sits behind foreground panels.
 *
 * Most columns rain random glyphs (Matrix-style); a tunable fraction instead
 * carry a coherent technical token (`0x` address, `/usr/lib/core.so`, `SEQ:1F3A`)
 * so the panel reads as complex data processing rather than noise. Every glyph
 * is a narrow, unambiguous-width codepoint so the terminal grid never tears.
 */
export class DataStreamRenderable extends Renderable {
	// ASCII-only token vocabulary. Every codepoint here is narrow (one cell), so
	// tokens can never tear the grid the way CJK/emoji/dingbats would.
	private static readonly HEX = '0123456789ABCDEF'
	private static readonly DIRS = [
		'src',
		'hud',
		'core',
		'net',
		'sys',
		'bin',
		'usr',
		'var',
		'dev',
		'proc',
		'pkg',
		'lib',
		'tmp',
		'opt',
		'etc',
	] as const
	private static readonly FILES = [
		'grid.ts',
		'main.rs',
		'core.so',
		'data.bin',
		'feed.json',
		'node.map',
		'mem.dmp',
		'io.sock',
		'x.log',
		'key.pem',
	] as const
	private static readonly TAGS = ['PID', 'SEQ', 'ADR', 'REF', 'ACK', 'CRC', 'SIG', 'MAP', 'TX', 'RX'] as const

	private _chars: string
	private _head: RGBA
	private _trail: RGBA
	private _tokenRatio: number
	private columns: Column[] = []
	private elapsed = 0

	constructor(ctx: RenderContext, options: DataStreamOptions) {
		super(ctx, { ...options, live: true })
		this._chars = options.chars
		this._head = parseColor(options.head)
		this._trail = parseColor(options.trail)
		this._tokenRatio = clamp01(options.tokenRatio ?? 0.45)
	}

	public set chars(next: string) {
		this._chars = next
	}

	public set head(next: string) {
		this._head = parseColor(next)
	}

	public set trail(next: string) {
		this._trail = parseColor(next)
	}

	public set tokenRatio(next: number) {
		this._tokenRatio = clamp01(next)
	}

	protected override onResize(): void {
		this.columns = []
	}

	/**
	 * Populate one column per screen cell. Called lazily from both `onUpdate`
	 * and `renderSelf`: `onUpdate` runs *before* layout is finalized on the very
	 * first frame (so `this.width` can still be stale there), whereas `renderSelf`
	 * always sees the final width — seeding in both guarantees a full field on
	 * frame one regardless of which fires first.
	 */
	private ensureSeeded(): void {
		if (this.columns.length !== this.width) {
			this.columns = Array.from({ length: this.width }, (_, i) => this.spawn(i, true))
		}
	}

	private spawn(index: number, initial: boolean): Column {
		const r = hash01(index * 7.31 + this.elapsed)
		// Fold elapsed time into the seed so a respawned column draws a fresh
		// token / glyph pattern rather than repeating its previous fall.
		const gen = Math.floor(this.elapsed * 2)
		const wantsToken = hash01(index * 5.17 + gen * 1.31) < this._tokenRatio
		return {
			// The first generation is scattered across the panel so the field is
			// populated on frame one; respawns drop in just above the top edge.
			y: initial ? hash01(index * 3.7) * (this.height + 6) - 6 : -hash01(index + this.elapsed) * 6,
			speed: 4 + r * 14,
			length: 3 + Math.floor(hash01(index * 1.9 + 0.5) * 8),
			seed: index * 31 + gen * 101,
			token: wantsToken ? this.makeToken(index * 131.7 + gen * 17.3) : null,
		}
	}

	/** N hex digits derived deterministically from `seed`. */
	private hexDigits(seed: number, n: number): string {
		let out = ''
		for (let i = 0; i < n; i++) {
			const h = Math.floor(hash01(seed + i * 2.17) * 16)
			out += DataStreamRenderable.HEX[h] ?? '0'
		}
		return out
	}

	/** A short, narrow-ASCII technical token: an address, a path, or a readout. */
	private makeToken(seed: number): string {
		const form = Math.floor(hash01(seed) * 3)
		if (form === 0) {
			const n = 3 + Math.floor(hash01(seed + 1.3) * 4) // 3..6 hex digits
			return `0x${this.hexDigits(seed + 4.1, n)}`
		}
		if (form === 1) {
			const segments = 2 + Math.floor(hash01(seed + 2.7) * 2) // 2..3 dirs
			let path = ''
			for (let i = 0; i < segments; i++) {
				const dirs = DataStreamRenderable.DIRS
				path += `/${dirs[Math.floor(hash01(seed + 10 + i * 3.3) * dirs.length)] ?? 'sys'}`
			}
			const files = DataStreamRenderable.FILES
			return `${path}/${files[Math.floor(hash01(seed + 30) * files.length)] ?? 'core.so'}`
		}
		const tags = DataStreamRenderable.TAGS
		const tag = tags[Math.floor(hash01(seed + 3.9) * tags.length)] ?? 'SEQ'
		return `${tag}:${this.hexDigits(seed + 5.5, 4)}`
	}

	protected override onUpdate(deltaTime: number): void {
		this.elapsed += deltaTime / 1000
		this.ensureSeeded()

		const dt = Math.min(deltaTime, 100) / 1000
		for (let i = 0; i < this.columns.length; i++) {
			const column = this.columns[i]
			if (!column) continue
			column.y += column.speed * dt
			if (column.y - column.length > this.height) this.columns[i] = this.spawn(i, false)
		}
	}

	protected override renderSelf(buffer: OptimizedBuffer): void {
		if (this._chars.length === 0 || this.width < 1 || this.height < 1) return
		this.ensureSeeded()
		// Flicker the random glyphs a few times a second rather than every frame.
		// Token columns ignore this and stay stable, so they read as steady data.
		const tick = Math.floor(this.elapsed * 6)

		for (let c = 0; c < this.columns.length; c++) {
			const column = this.columns[c]
			if (!column) continue
			const headRow = Math.floor(column.y)

			for (let i = 0; i < column.length; i++) {
				const row = headRow - i
				if (row < 0 || row >= this.height) continue

				let glyph: string
				if (column.token) {
					const token = column.token
					const idx = ((row % token.length) + token.length) % token.length
					glyph = token[idx] ?? '0'
				} else {
					const glyphIndex = Math.floor(hash01(column.seed + row * 17 + tick) * this._chars.length)
					glyph = this._chars[glyphIndex] ?? '0'
				}

				const isHead = i === 0
				const alpha = 1 - i / column.length
				const color = isHead ? this._head : fade(this._trail, alpha * alpha)
				const attributes = isHead ? TextAttributes.BOLD : TextAttributes.DIM

				buffer.setCellWithAlphaBlending(this.x + c, this.y + row, glyph, color, TRANSPARENT, attributes)
			}
		}
	}
}

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0
	return value < 0 ? 0 : value > 1 ? 1 : value
}
