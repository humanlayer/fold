/**
 * This file implements the pure text-matching engine behind the edit tool (D18, pi port from
 * edit-diff.ts): exact substring match first, then a normalization fallback (NFKC, per-line trailing
 * whitespace, smart quotes/dashes/special spaces) that is still exact substring matching - never fuzzy.
 * All edits match against the original content; overlaps are rejected; untouched lines stay
 * byte-identical even when a normalized match was needed; BOM and CRLF endings are preserved. Error
 * strings are pi's, verbatim. Pure and isomorphic: platform handlers do the file IO around it.
 */
import { Effect, Schema } from 'effect'

/** One targeted replacement: exact old text and its replacement. */
export type EditPair = {
	readonly oldText: string
	readonly newText: string
}

/** A model-visible edit failure. `message` strings are pi's, verbatim. */
export class EditEngineError extends Schema.TaggedErrorClass<EditEngineError>()('EditEngineError', {
	message: Schema.String,
}) {}

const bomCharacter = '﻿'

/** Strip a single leading BOM, remembering it for re-attachment. */
export const stripBom = (text: string): { readonly bom: string; readonly text: string } =>
	text.startsWith(bomCharacter) ? { bom: bomCharacter, text: text.slice(1) } : { bom: '', text }

/** Detect the file's line ending from its first newline (pi semantics: first line wins). */
export const detectLineEnding = (text: string): '\r\n' | '\n' => {
	const index = text.indexOf('\n')
	return index > 0 && text[index - 1] === '\r' ? '\r\n' : '\n'
}

/** Normalize CRLF and lone CR to LF for matching. */
export const normalizeToLF = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

/** Re-apply the detected line ending after matching happened in LF space. */
export const restoreLineEndings = (text: string, ending: '\r\n' | '\n'): string =>
	ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text

const smartSingleQuotes = /[‘’‚‛]/g
const smartDoubleQuotes = /[“”„‟]/g
const unicodeDashes = /[‐‑‒–—―−]/g
const specialSpaces = /[  -   　]/g

/**
 * The normalization fallback (pi's `normalizeForFuzzyMatch`): still exact substring matching, but in a
 * canonicalized space. Steps in order: NFKC, per-line trailing-whitespace strip, smart single quotes,
 * smart double quotes, unicode dashes, special spaces.
 */
export const normalizeForMatch = (text: string): string =>
	text
		.normalize('NFKC')
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n')
		.replace(smartSingleQuotes, "'")
		.replace(smartDoubleQuotes, '"')
		.replace(unicodeDashes, '-')
		.replace(specialSpaces, ' ')

type FoundMatch = {
	readonly index: number
	readonly matchLength: number
	readonly usedNormalizedMatch: boolean
}

/** Find `oldText` in `content`: exact first, then in normalized space (pi's `fuzzyFindText`). */
const findText = (content: string, oldText: string): FoundMatch | null => {
	const exactIndex = content.indexOf(oldText)
	if (exactIndex !== -1) return { index: exactIndex, matchLength: oldText.length, usedNormalizedMatch: false }

	const normalizedContent = normalizeForMatch(content)
	const normalizedOldText = normalizeForMatch(oldText)
	const normalizedIndex = normalizedContent.indexOf(normalizedOldText)
	if (normalizedIndex === -1) return null

	return { index: normalizedIndex, matchLength: normalizedOldText.length, usedNormalizedMatch: true }
}

/** Count occurrences in normalized space (pi counts there regardless of how the match was found). */
const countOccurrences = (content: string, oldText: string): number =>
	normalizeForMatch(content).split(normalizeForMatch(oldText)).length - 1

type MatchedEdit = {
	readonly editIndex: number
	readonly matchIndex: number
	readonly matchLength: number
	readonly newText: string
}

/** Apply replacements right-to-left so earlier offsets stay valid (pi's reverse splice). */
const applyReplacements = (content: string, replacements: ReadonlyArray<MatchedEdit>): string => {
	let result = content
	for (let index = replacements.length - 1; index >= 0; index -= 1) {
		const replacement = replacements[index]
		if (replacement === undefined) continue
		result =
			result.substring(0, replacement.matchIndex) +
			replacement.newText +
			result.substring(replacement.matchIndex + replacement.matchLength)
	}
	return result
}

/** Split text into lines that keep their trailing newline (pi's `splitLinesWithEndings`). */
const splitLinesWithEndings = (content: string): ReadonlyArray<string> => content.match(/[^\n]*\n|[^\n]+/g) ?? []

/** Map a character span in the base content to the inclusive line range it touches. */
const lineRangeFor = (
	lineOffsets: ReadonlyArray<number>,
	matchIndex: number,
	matchLength: number,
): { readonly first: number; readonly last: number } => {
	let first = 0
	let last = 0
	for (let line = 0; line < lineOffsets.length; line += 1) {
		const start = lineOffsets[line] ?? 0
		if (start <= matchIndex) first = line
		if (start < matchIndex + Math.max(matchLength, 1)) last = line
	}
	return { first, last }
}

/**
 * Apply replacements found in normalized space while copying every untouched line verbatim from the
 * original (pi's `applyReplacementsPreservingUnchangedLines`): only the line groups a replacement
 * touches are emitted from the normalized base; everything else keeps its original bytes.
 */
const applyReplacementsPreservingUnchangedLines = (
	originalContent: string,
	normalizedBase: string,
	replacements: ReadonlyArray<MatchedEdit>,
): Effect.Effect<string, EditEngineError> => {
	const originalLines = splitLinesWithEndings(originalContent)
	const baseLines = splitLinesWithEndings(normalizedBase)

	if (originalLines.length !== baseLines.length) {
		return Effect.fail(
			new EditEngineError({
				message: 'Cannot preserve unchanged lines because the base content has a different line count.',
			}),
		)
	}

	const offsets: Array<number> = []
	let offset = 0
	for (const line of baseLines) {
		offsets.push(offset)
		offset += line.length
	}

	// Widen each replacement to whole lines and group adjacent/overlapping ranges.
	const ranges = replacements
		.map((replacement) => ({
			...lineRangeFor(offsets, replacement.matchIndex, replacement.matchLength),
			replacement,
		}))
		.sort((a, b) => a.first - b.first)
	const groups: Array<{ first: number; last: number; members: Array<MatchedEdit> }> = []
	for (const range of ranges) {
		const current = groups[groups.length - 1]
		if (current !== undefined && range.first <= current.last + 1) {
			current.last = Math.max(current.last, range.last)
			current.members.push(range.replacement)
		} else {
			groups.push({ first: range.first, last: range.last, members: [range.replacement] })
		}
	}

	let result = ''
	let cursor = 0
	for (const group of groups) {
		result += originalLines.slice(cursor, group.first).join('')

		const groupStart = offsets[group.first] ?? 0
		const groupEnd =
			group.last + 1 < baseLines.length
				? (offsets[group.last + 1] ?? normalizedBase.length)
				: normalizedBase.length
		const groupText = normalizedBase.substring(groupStart, groupEnd)
		const rebased = group.members
			.map((member) => ({ ...member, matchIndex: member.matchIndex - groupStart }))
			.sort((a, b) => a.matchIndex - b.matchIndex)
		result += applyReplacements(groupText, rebased)
		cursor = group.last + 1
	}
	result += originalLines.slice(cursor).join('')

	return Effect.succeed(result)
}

/** Outcome of a successful edit application. */
export type ApplyEditsOutcome = {
	/** Final file content, BOM and original line endings restored. */
	readonly content: string
	readonly editsApplied: number
}

/**
 * Apply one batch of edits to raw file content (pi's execute + `applyEditsToNormalizedContent`).
 * `path` appears only inside error messages. All edits match against the original content; if any edit
 * needs the normalization fallback, every edit is re-matched in normalized space, and untouched lines
 * are preserved byte-for-byte from the original.
 */
export const applyEdits = (input: {
	readonly rawContent: string
	readonly edits: ReadonlyArray<EditPair>
	readonly path: string
}): Effect.Effect<ApplyEditsOutcome, EditEngineError> =>
	Effect.gen(function* () {
		const { edits, path } = input
		const { bom, text } = stripBom(input.rawContent)
		const originalEnding = detectLineEnding(text)
		const normalizedContent = normalizeToLF(text)
		const normalizedEdits = edits.map((edit) => ({
			oldText: normalizeToLF(edit.oldText),
			newText: normalizeToLF(edit.newText),
		}))
		const single = normalizedEdits.length === 1

		for (const [index, edit] of normalizedEdits.entries()) {
			if (edit.oldText.length === 0) {
				return yield* new EditEngineError({
					message: single
						? `oldText must not be empty in ${path}.`
						: `edits[${index}].oldText must not be empty in ${path}.`,
				})
			}
		}

		// If ANY edit needs the normalized fallback, all edits switch to normalized space (pi semantics).
		const initialMatches = normalizedEdits.map((edit) => findText(normalizedContent, edit.oldText))
		const usedNormalizedMatch = initialMatches.some((match) => match?.usedNormalizedMatch === true)
		const baseContent = usedNormalizedMatch ? normalizeForMatch(normalizedContent) : normalizedContent

		const matchedEdits: Array<MatchedEdit> = []
		for (const [index, edit] of normalizedEdits.entries()) {
			// pi's fuzzyFindText: even against the normalized base, the raw oldText is tried exactly
			// first (its match length differs from the normalized target's when normalization shrinks it).
			let target = edit.oldText
			let matchIndex = baseContent.indexOf(target)
			if (matchIndex === -1 && usedNormalizedMatch) {
				target = normalizeForMatch(edit.oldText)
				matchIndex = baseContent.indexOf(target)
			}

			if (matchIndex === -1) {
				return yield* new EditEngineError({
					message: single
						? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
						: `Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
				})
			}

			const occurrences = countOccurrences(normalizedContent, edit.oldText)
			if (occurrences > 1) {
				return yield* new EditEngineError({
					message: single
						? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
						: `Found ${occurrences} occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
				})
			}

			matchedEdits.push({ editIndex: index, matchIndex, matchLength: target.length, newText: edit.newText })
		}

		matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex)
		for (let index = 1; index < matchedEdits.length; index += 1) {
			const previous = matchedEdits[index - 1]
			const current = matchedEdits[index]
			if (
				previous !== undefined &&
				current !== undefined &&
				previous.matchIndex + previous.matchLength > current.matchIndex
			) {
				return yield* new EditEngineError({
					message: `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
				})
			}
		}

		const newContent = usedNormalizedMatch
			? yield* applyReplacementsPreservingUnchangedLines(normalizedContent, baseContent, matchedEdits)
			: applyReplacements(baseContent, matchedEdits)

		if (newContent === normalizedContent) {
			return yield* new EditEngineError({
				message: single
					? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
					: `No changes made to ${path}. The replacements produced identical content.`,
			})
		}

		return {
			content: bom + restoreLineEndings(newContent, originalEnding),
			editsApplied: edits.length,
		}
	})

const isEditPair = (value: unknown): value is EditPair => {
	if (typeof value !== 'object' || value === null) return false
	if (!('oldText' in value) || !('newText' in value)) return false
	return typeof value.oldText === 'string' && typeof value.newText === 'string'
}

/**
 * Normalize edit-tool input into an edit batch (pi's `prepareEditArguments` + `validateEditInput`):
 * accepts the batch form, a JSON-string edits array (some models stringify it), and the legacy
 * top-level oldText/newText pair, which appends as the final edit.
 */
export const normalizeEditInput = (input: {
	readonly edits?: ReadonlyArray<EditPair> | string | undefined
	readonly oldText?: string | undefined
	readonly newText?: string | undefined
}): Effect.Effect<ReadonlyArray<EditPair>, EditEngineError> =>
	Effect.gen(function* () {
		const invalidEdits = new EditEngineError({
			message: 'Edit tool input is invalid. edits must be an array of {oldText, newText}.',
		})
		let edits: Array<EditPair> = []

		if (typeof input.edits === 'string') {
			const editsText = input.edits
			const parsed = yield* Effect.try({
				try: (): unknown => JSON.parse(editsText),
				catch: () => invalidEdits,
			})
			if (!Array.isArray(parsed)) return yield* invalidEdits

			for (const item of parsed) {
				if (!isEditPair(item)) return yield* invalidEdits
				edits.push({ oldText: item.oldText, newText: item.newText })
			}
		} else if (input.edits !== undefined) {
			edits = [...input.edits]
		}

		if (typeof input.oldText === 'string' && typeof input.newText === 'string') {
			edits.push({ oldText: input.oldText, newText: input.newText })
		}

		if (edits.length === 0) {
			return yield* new EditEngineError({
				message: 'Edit tool input is invalid. edits must contain at least one replacement.',
			})
		}

		return edits
	})
