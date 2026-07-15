/**
 * This file implements the pure apply_patch engine (D18): parsing and hunk computation with no file
 * IO, so platform handlers read/write around it and browser hosts can reuse it. Input rules follow
 * opencode/agentlayer (verified materially identical): the V4A envelope with required Begin/End
 * markers, Add/Update/Delete/Move headers, @@ context, *** End of File anchoring, and the shared
 * 4-pass line matcher (exact, rstrip, trim, unicode-fold) - plus clanka's strict superset of accepting
 * raw git/unified diffs. Failures are typed tagged errors, not defects (contrast clanka's orDie).
 */
import { Effect, Schema } from 'effect'

/** The patch text could not be parsed into file operations. */
export class PatchParseError extends Schema.TaggedErrorClass<PatchParseError>()('PatchParseError', {
	message: Schema.String,
}) {}

/** A hunk's context or expected lines were not found in the target file. */
export class HunkNotFoundError extends Schema.TaggedErrorClass<HunkNotFoundError>()('HunkNotFoundError', {
	message: Schema.String,
	path: Schema.String,
}) {}

/** An update/delete referenced a file the caller could not supply. */
export class PatchFileNotFoundError extends Schema.TaggedErrorClass<PatchFileNotFoundError>()(
	'PatchFileNotFoundError',
	{
		message: Schema.String,
		path: Schema.String,
	},
) {}

/** Everything patch application can fail with after parsing. */
export type PatchApplyError = HunkNotFoundError | PatchFileNotFoundError

/** One @@ hunk: optional locating context, expected old lines, replacement new lines. */
export type PatchChunk = {
	readonly context: string
	readonly oldLines: ReadonlyArray<string>
	readonly newLines: ReadonlyArray<string>
	readonly isEndOfFile: boolean
}

/** One parsed file operation. Move is an update carrying `movePath` (opencode/clanka shape). */
export type PatchOp =
	| { readonly _tag: 'add'; readonly path: string; readonly content: string }
	| { readonly _tag: 'delete'; readonly path: string }
	| {
			readonly _tag: 'update'
			readonly path: string
			readonly movePath: string | null
			readonly chunks: ReadonlyArray<PatchChunk>
	  }

const beginMarker = '*** Begin Patch'
const endMarker = '*** End Patch'
const addMarker = '*** Add File:'
const deleteMarker = '*** Delete File:'
const updateMarker = '*** Update File:'
const moveMarker = '*** Move to:'
const eofMarker = '*** End of File'

/** Unwrap `cat <<'EOF' ... EOF` heredoc wrappers models sometimes emit around the patch. */
const stripHeredoc = (text: string): string => {
	const lines = text.split('\n')
	const first = lines[0] ?? ''
	const heredoc = first.match(/<<-?\s*['"]?(\w+)['"]?\s*$/)
	if (heredoc === null) return text

	const delimiter = heredoc[1] ?? ''
	let end = lines.length - 1
	while (end > 0 && (lines[end] ?? '').trim() === '') end -= 1
	if ((lines[end] ?? '').trim() !== delimiter) return text

	return lines.slice(1, end).join('\n')
}

/** Fold the unicode punctuation opencode/agentlayer/clanka all fold before comparing lines. */
const normalizeUnicode = (text: string): string =>
	text
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―]/g, '-')
		.replace(/…/g, '...')
		.replace(/ /g, ' ')

type LineComparator = (a: string, b: string) => boolean

/** The shared 4-pass comparator ladder: exact, rstrip, trim, unicode-fold (first pass to match wins). */
const matchPasses: ReadonlyArray<LineComparator> = [
	(a, b) => a === b,
	(a, b) => a.trimEnd() === b.trimEnd(),
	(a, b) => a.trim() === b.trim(),
	(a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
]

const sequenceMatchesAt = (
	lines: ReadonlyArray<string>,
	pattern: ReadonlyArray<string>,
	position: number,
	compare: LineComparator,
): boolean => {
	if (position < 0 || position + pattern.length > lines.length) return false
	for (let index = 0; index < pattern.length; index += 1) {
		if (!compare(lines[position + index] ?? '', pattern[index] ?? '')) return false
	}
	return true
}

/**
 * Find `pattern` inside `lines` at or after `startIndex` with the 4-pass ladder; when `eof` is set the
 * end-anchored position is tried first (all three reference implementations agree). Returns -1 when no
 * pass matches anywhere.
 */
export const seekSequence = (
	lines: ReadonlyArray<string>,
	pattern: ReadonlyArray<string>,
	startIndex: number,
	eof: boolean,
): number => {
	if (pattern.length === 0) return -1

	for (const compare of matchPasses) {
		if (eof) {
			const anchored = lines.length - pattern.length
			if (anchored >= startIndex && sequenceMatchesAt(lines, pattern, anchored, compare)) return anchored
		}
		for (let position = startIndex; position <= lines.length - pattern.length; position += 1) {
			if (sequenceMatchesAt(lines, pattern, position, compare)) return position
		}
	}

	return -1
}

// --- V4A parsing --------------------------------------------------------------------------------------

type ChunkParseState = {
	readonly chunks: Array<PatchChunk>
	current: {
		context: string
		oldLines: Array<string>
		newLines: Array<string>
		isEndOfFile: boolean
		touched: boolean
	}
}

const emptyChunk = () => ({ context: '', oldLines: [], newLines: [], isEndOfFile: false, touched: false })

const flushChunk = (state: ChunkParseState): void => {
	if (state.current.touched) {
		state.chunks.push({
			context: state.current.context,
			oldLines: state.current.oldLines,
			newLines: state.current.newLines,
			isEndOfFile: state.current.isEndOfFile,
		})
	}
	state.current = emptyChunk()
}

/** Feed one hunk-body line into the chunk state. Unprefixed lines are dropped (all three references). */
const feedChunkLine = (state: ChunkParseState, line: string): void => {
	if (line.startsWith('+')) {
		state.current.newLines.push(line.slice(1))
		state.current.touched = true
	} else if (line.startsWith('-')) {
		state.current.oldLines.push(line.slice(1))
		state.current.touched = true
	} else if (line.startsWith(' ')) {
		state.current.oldLines.push(line.slice(1))
		state.current.newLines.push(line.slice(1))
		state.current.touched = true
	}
}

const parseV4A = (lines: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<PatchOp>, PatchParseError> =>
	Effect.gen(function* () {
		const beginIndex = lines.findIndex((line) => line.trim() === beginMarker)
		const endIndex = lines.findIndex((line) => line.trim() === endMarker)

		if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
			return yield* new PatchParseError({ message: 'Invalid patch format: missing Begin/End markers' })
		}

		const ops: Array<PatchOp> = []
		let index = beginIndex + 1

		while (index < endIndex) {
			const line = lines[index] ?? ''

			if (line.startsWith(addMarker)) {
				const path = line.slice(addMarker.length).trim()
				const content: Array<string> = []
				index += 1
				while (index < endIndex && !(lines[index] ?? '').startsWith('***')) {
					const contentLine = lines[index] ?? ''
					if (contentLine.startsWith('+')) content.push(contentLine.slice(1))
					index += 1
				}
				ops.push({ _tag: 'add', path, content: content.join('\n') })
				continue
			}

			if (line.startsWith(deleteMarker)) {
				ops.push({ _tag: 'delete', path: line.slice(deleteMarker.length).trim() })
				index += 1
				continue
			}

			if (line.startsWith(updateMarker)) {
				const path = line.slice(updateMarker.length).trim()
				index += 1

				let movePath: string | null = null
				if (index < endIndex && (lines[index] ?? '').startsWith(moveMarker)) {
					movePath = (lines[index] ?? '').slice(moveMarker.length).trim()
					index += 1
				}

				const state: ChunkParseState = { chunks: [], current: emptyChunk() }
				while (index < endIndex) {
					const bodyLine = lines[index] ?? ''
					if (bodyLine.trim() === eofMarker) {
						state.current.isEndOfFile = true
						state.current.touched = true
						index += 1
						continue
					}
					if (bodyLine.startsWith('***')) break
					if (bodyLine.startsWith('@@')) {
						flushChunk(state)
						state.current.context = bodyLine.slice(2).trim()
						state.current.touched = true
						index += 1
						continue
					}
					feedChunkLine(state, bodyLine)
					index += 1
				}
				flushChunk(state)

				ops.push({ _tag: 'update', path, movePath, chunks: state.chunks })
				continue
			}

			// Unknown or blank line between operations: skip (opencode/agentlayer behavior).
			index += 1
		}

		return ops
	})

// --- git / unified diff parsing -------------------------------------------------------------------------

const hasDiffHeaders = (lines: ReadonlyArray<string>): boolean =>
	lines.some(
		(line) =>
			line.startsWith('diff --git ') ||
			line.startsWith('--- ') ||
			line.startsWith('rename from ') ||
			line.startsWith('rename to '),
	)

/** Strip `a/` / `b/` prefixes and trailing tab metadata from a diff header path; null for /dev/null. */
const diffHeaderPath = (raw: string): string | null => {
	const withoutTab = raw.split('\t')[0] ?? raw
	const trimmed = withoutTab.trim()
	if (trimmed === '/dev/null') return null
	if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) return trimmed.slice(2)
	return trimmed
}

const unifiedHunkHeader = /^@@\s*(?:-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s*)?@@\s*(.*)$/

const skippableGitMetadata = [
	'index ',
	'similarity index ',
	'dissimilarity index ',
	'new file mode ',
	'deleted file mode ',
	'old mode ',
	'new mode ',
	'Binary files ',
	'GIT binary patch',
]

type GitFileState = {
	fromPath: string | null
	toPath: string | null
	renameFrom: string | null
	renameTo: string | null
	sawHeader: boolean
	chunks: ChunkParseState
}

const parseGitDiff = (lines: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<PatchOp>, PatchParseError> =>
	Effect.gen(function* () {
		const ops: Array<PatchOp> = []
		let file: GitFileState | null = null

		const finishFile = (state: GitFileState | null): Effect.Effect<void, PatchParseError> =>
			Effect.gen(function* () {
				if (state === null) return
				flushChunk(state.chunks)

				const fromPath = state.renameFrom ?? state.fromPath
				const toPath = state.renameTo ?? state.toPath

				if (fromPath === null && toPath === null) {
					return yield* new PatchParseError({ message: 'invalid diff: both file paths are /dev/null' })
				}

				// --- /dev/null → add; +++ /dev/null → delete; rename → update with movePath.
				if (fromPath === null && toPath !== null) {
					// Zero hunks means an empty file (clanka, the git-diff authority).
					const content = state.chunks.chunks.flatMap((chunk) => chunk.newLines)
					ops.push({ _tag: 'add', path: toPath, content: content.join('\n') })
					return
				}
				if (toPath === null && fromPath !== null) {
					ops.push({ _tag: 'delete', path: fromPath })
					return
				}
				if (fromPath === null || toPath === null) return

				const movePath = fromPath === toPath ? null : toPath
				if (state.chunks.chunks.length === 0 && movePath === null) {
					return yield* new PatchParseError({ message: `no hunks found for ${fromPath}` })
				}
				ops.push({ _tag: 'update', path: fromPath, movePath, chunks: state.chunks.chunks })
			})

		for (const line of lines) {
			if (line.startsWith('diff --git ')) {
				yield* finishFile(file)
				const header = line.slice('diff --git '.length).match(/^a\/(\S+)\s+b\/(\S+)\s*$/)
				if (header === null) {
					return yield* new PatchParseError({ message: `invalid git diff header: ${line}` })
				}
				file = {
					fromPath: header[1] ?? null,
					toPath: header[2] ?? null,
					renameFrom: null,
					renameTo: null,
					sawHeader: false,
					chunks: { chunks: [], current: emptyChunk() },
				}
				continue
			}

			if (line.startsWith('rename from ')) {
				if (file !== null) file.renameFrom = line.slice('rename from '.length).trim()
				continue
			}
			if (line.startsWith('rename to ')) {
				if (file !== null) file.renameTo = line.slice('rename to '.length).trim()
				continue
			}

			if (line.startsWith('--- ')) {
				const path = diffHeaderPath(line.slice(4))
				if (file === null) {
					file = {
						fromPath: path,
						toPath: null,
						renameFrom: null,
						renameTo: null,
						sawHeader: true,
						chunks: { chunks: [], current: emptyChunk() },
					}
				} else {
					file.fromPath = path
					file.sawHeader = true
				}
				continue
			}
			if (line.startsWith('+++ ')) {
				if (file === null || !file.sawHeader) {
					return yield* new PatchParseError({ message: 'missing new file header' })
				}
				file.toPath = diffHeaderPath(line.slice(4))
				continue
			}

			const hunk = line.match(unifiedHunkHeader)
			if (hunk !== null && file !== null) {
				flushChunk(file.chunks)
				file.chunks.current.context = hunk[1]?.trim() ?? ''
				file.chunks.current.touched = true
				continue
			}

			if (line === String.raw`\ No newline at end of file`) continue
			if (skippableGitMetadata.some((prefix) => line.startsWith(prefix))) continue

			if (file !== null && file.chunks.current.touched) {
				feedChunkLine(file.chunks, line)
			}
		}

		yield* finishFile(file)

		if (ops.length === 0) return yield* new PatchParseError({ message: 'no hunks found' })
		return ops
	})

// --- entry points ---------------------------------------------------------------------------------------

/**
 * Parse patch text into file operations. Accepts the V4A envelope (Begin/End required, opencode and
 * agentlayer rules) and raw git/unified diffs (clanka's superset). CRLF is normalized before parsing.
 */
export const parsePatch = (patchText: string): Effect.Effect<ReadonlyArray<PatchOp>, PatchParseError> =>
	Effect.gen(function* () {
		const normalized = stripHeredoc(patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim())

		if (normalized.length === 0) {
			return yield* new PatchParseError({ message: 'patch_text is required' })
		}

		const lines = normalized.split('\n')

		if (lines.some((line) => line.trim() === beginMarker)) {
			const ops = yield* parseV4A(lines)
			if (ops.length === 0) return yield* new PatchParseError({ message: 'patch rejected: empty patch' })
			return ops
		}

		if (hasDiffHeaders(lines)) return yield* parseGitDiff(lines)

		return yield* new PatchParseError({
			message: 'Invalid patch format: expected *** Begin Patch or a git/unified diff',
		})
	})

/** Apply one update op's chunks to file content (pure; CRLF detected, applied in LF, restored). */
export const applyChunks = (input: {
	readonly content: string
	readonly chunks: ReadonlyArray<PatchChunk>
	readonly path: string
}): Effect.Effect<string, HunkNotFoundError> =>
	Effect.gen(function* () {
		const { chunks, path } = input
		const usesCrlf = input.content.includes('\r\n')
		const normalized = input.content.replace(/\r\n/g, '\n')
		const lines = normalized.split('\n')

		// A trailing newline parses as a trailing empty line; drop it for matching (references), and the
		// exactly-one-trailing-newline rule below restores it.
		if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

		type Replacement = {
			readonly index: number
			readonly deleteCount: number
			readonly newLines: ReadonlyArray<string>
		}
		const replacements: Array<Replacement> = []
		let lineIndex = 0

		for (const chunk of chunks) {
			if (chunk.context !== '') {
				const contextIndex = seekSequence(lines, [chunk.context], lineIndex, false)
				if (contextIndex === -1) {
					return yield* new HunkNotFoundError({
						message: `Failed to find context '${chunk.context}' in ${path}`,
						path,
					})
				}
				lineIndex = contextIndex + 1
			}

			if (chunk.oldLines.length === 0) {
				// Pure insertion: anchored at end of file (all three reference implementations).
				replacements.push({ index: lines.length, deleteCount: 0, newLines: chunk.newLines })
				continue
			}

			let oldLines = chunk.oldLines
			let newLines = chunk.newLines
			let matchIndex = seekSequence(lines, oldLines, lineIndex, chunk.isEndOfFile)

			// Retry once dropping one trailing empty line from the pattern (opencode/agentlayer/clanka).
			if (matchIndex === -1 && oldLines[oldLines.length - 1] === '') {
				oldLines = oldLines.slice(0, -1)
				if (newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1)
				if (oldLines.length > 0) matchIndex = seekSequence(lines, oldLines, lineIndex, chunk.isEndOfFile)
			}

			if (matchIndex === -1) {
				return yield* new HunkNotFoundError({
					message: `Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`,
					path,
				})
			}

			replacements.push({ index: matchIndex, deleteCount: oldLines.length, newLines })
			lineIndex = matchIndex + oldLines.length
		}

		for (const replacement of [...replacements].sort((a, b) => b.index - a.index)) {
			lines.splice(replacement.index, replacement.deleteCount, ...replacement.newLines)
		}

		// Exactly one trailing newline, reference semantics: append an empty segment only when the last
		// line is non-empty (a surviving empty last line already yields the newline on join).
		if (lines[lines.length - 1] !== '') lines.push('')
		const result = lines.join('\n')
		return usesCrlf ? result.replace(/\n/g, '\r\n') : result
	})

/** One concrete filesystem step the handler performs after a successful dry run. */
export type PatchStep =
	| { readonly _tag: 'write'; readonly path: string; readonly content: string }
	| { readonly _tag: 'delete'; readonly path: string }
	| { readonly _tag: 'move'; readonly fromPath: string; readonly toPath: string; readonly content: string }

/** Result of computing a whole patch: the steps to perform and a human summary per op. */
export type ComputedPatch = {
	readonly steps: ReadonlyArray<PatchStep>
	readonly summary: ReadonlyArray<string>
}

/**
 * Dry-run a parsed patch against in-memory file contents (validate-then-write atomicity: callers read
 * every referenced file first, run this, and only then perform the returned steps). Cross-op state is
 * tracked in memory, so a file added earlier in the patch can be updated later, and referencing a file
 * deleted earlier fails.
 */
export const computePatch = (input: {
	readonly ops: ReadonlyArray<PatchOp>
	/** Current content for every referenced path; null when the file does not exist. */
	readonly files: ReadonlyMap<string, string | null>
}): Effect.Effect<ComputedPatch, PatchApplyError> =>
	Effect.gen(function* () {
		const state = new Map<string, string | null>(input.files)
		const steps: Array<PatchStep> = []
		const summary: Array<string> = []

		const readFor = (path: string, action: 'update' | 'delete'): Effect.Effect<string, PatchFileNotFoundError> => {
			const content = state.get(path)
			if (content === undefined || content === null) {
				return Effect.fail(
					new PatchFileNotFoundError({ message: `Failed to read file to ${action}: ${path}`, path }),
				)
			}
			return Effect.succeed(content)
		}

		for (const op of input.ops) {
			switch (op._tag) {
				case 'add': {
					// Ensure exactly one trailing newline; content ending in a bare `+` line already has one.
					const content =
						op.content.length === 0 || op.content.endsWith('\n') ? op.content : `${op.content}\n`
					state.set(op.path, content)
					steps.push({ _tag: 'write', path: op.path, content })
					summary.push(`Added: ${op.path}`)
					break
				}

				case 'delete': {
					yield* readFor(op.path, 'delete')
					state.set(op.path, null)
					steps.push({ _tag: 'delete', path: op.path })
					summary.push(`Deleted: ${op.path}`)
					break
				}

				case 'update': {
					const current = yield* readFor(op.path, 'update')
					const next = yield* applyChunks({ content: current, chunks: op.chunks, path: op.path })

					if (op.movePath === null) {
						state.set(op.path, next)
						steps.push({ _tag: 'write', path: op.path, content: next })
						summary.push(`Updated: ${op.path}`)
					} else {
						state.set(op.path, null)
						state.set(op.movePath, next)
						steps.push({ _tag: 'move', fromPath: op.path, toPath: op.movePath, content: next })
						summary.push(`Updated: ${op.path} (moved to ${op.movePath})`)
					}
					break
				}
			}
		}

		return { steps, summary }
	})
