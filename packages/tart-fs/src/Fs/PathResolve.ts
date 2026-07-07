/**
 * This file ports pi's path handling for the file tools (D18): input normalization (unicode spaces,
 * `@` prefix, `~` expansion, file:// URLs, cwd resolution) plus read's macOS filename-variant fallback
 * - screenshot narrow no-break spaces before AM/PM, NFD decomposition, curly apostrophes, and the NFD +
 * curly combination - tried in that order against the filesystem.
 */
import { homedir } from 'node:os'
import { isAbsolute, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Effect, type FileSystem } from 'effect'

const unicodeSpaces = /[  -   　]/g

/** Normalize a model-supplied path and resolve it against the working directory (pi's resolvePath). */
export const resolveToCwd = (filePath: string, cwd: string): string => {
	let path = filePath.trim().replace(unicodeSpaces, ' ')

	if (path.startsWith('@')) path = path.slice(1)
	if (path.startsWith('file://')) path = fileURLToPath(path)
	if (path === '~') path = homedir()
	else if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2))

	return isAbsolute(path) ? normalize(path) : resolve(cwd, path)
}

/** macOS screenshot names put a narrow no-break space before AM/PM. */
const macosScreenshotVariant = (path: string): string => path.replace(/ (AM|PM)\./gi, ' $1.')

/** macOS stores filenames NFD-decomposed. */
const nfdVariant = (path: string): string => path.normalize('NFD')

/** Filenames often carry curly apostrophes where the model typed a straight one. */
const curlyQuoteVariant = (path: string): string => path.replace(/'/g, '’')

const exists = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean> =>
	fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))

/**
 * Resolve a path for reading, trying pi's macOS filename variants in order when the resolved path does
 * not exist: as-is, narrow-no-break-space AM/PM, NFD, curly apostrophe, NFD + curly. Returns the first
 * existing variant, or the plain resolved path when none exists (the caller surfaces the read error).
 */
export const resolveReadPath = (filePath: string, cwd: string, fs: FileSystem.FileSystem): Effect.Effect<string> =>
	Effect.gen(function* () {
		const resolved = resolveToCwd(filePath, cwd)
		if (yield* exists(fs, resolved)) return resolved

		const variants = [
			macosScreenshotVariant(resolved),
			nfdVariant(resolved),
			curlyQuoteVariant(resolved),
			curlyQuoteVariant(nfdVariant(resolved)),
		]
		for (const variant of variants) {
			if (variant !== resolved && (yield* exists(fs, variant))) return variant
		}

		return resolved
	})
