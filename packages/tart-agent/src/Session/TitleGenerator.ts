import type { LogEntry, TartModel } from '@humanlayer/tart-core'
import { languageModelLayerFor } from '@humanlayer/tart-core'
import { Effect, Schema } from 'effect'
import { LanguageModel } from 'effect/unstable/ai'

const TitleResult = Schema.Struct({ title: Schema.String })
const MAX_TRANSCRIPT_CHARS = 12_000

const messageText = (entry: LogEntry): string => {
	if (entry._tag !== 'user-message' && entry._tag !== 'assistant-message') return ''
	return typeof entry.message.content === 'string'
		? entry.message.content
		: entry.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

/** Normalize model output to a single, safe title of at most six words. */
export const normalizeSessionTitle = (title: string): string =>
	title
		.replace(/[\r\n]+/g, ' ')
		.replace(/^[\s"'`]+|[\s"'`]+$/g, '')
		.replace(/\s+/g, ' ')
		.split(' ')
		.filter(Boolean)
		.slice(0, 6)
		.join(' ')

export const fallbackSessionTitle = (entries: ReadonlyArray<LogEntry>, rootAgentId: string): string => {
	const first = entries.find((entry) => entry._tag === 'user-message' && entry.agentId === rootAgentId)
	return normalizeSessionTitle(first === undefined ? '' : messageText(first)) || 'Untitled session'
}

/** Root user/assistant text only, bounded from the oldest root turn forward. */
export const titleTranscript = (entries: ReadonlyArray<LogEntry>, rootAgentId: string): string =>
	entries
		.filter(
			(entry) =>
				entry.agentId === rootAgentId && (entry._tag === 'user-message' || entry._tag === 'assistant-message'),
		)
		.map((entry) => `${entry._tag === 'user-message' ? 'User' : 'Assistant'}: ${messageText(entry)}`)
		.join('\n')
		.slice(0, MAX_TRANSCRIPT_CHARS)

/** One unlogged structured generation call. Callers persist only the resulting session_title event. */
export const generateSessionTitle = (
	entries: ReadonlyArray<LogEntry>,
	rootAgentId: string,
	model: TartModel,
): Effect.Effect<string> => {
	const fallback = fallbackSessionTitle(entries, rootAgentId)
	const transcript = titleTranscript(entries, rootAgentId)
	if (transcript.length === 0) return Effect.succeed(fallback)

	return LanguageModel.generateObject({
		schema: TitleResult,
		prompt:
			'Create a concise title of at most six words for this coding session. Return only the structured title.\n\n' +
			transcript,
	}).pipe(
		Effect.provide(languageModelLayerFor(model)),
		Effect.map((response) => normalizeSessionTitle(response.value.title) || fallback),
		Effect.catchCause(() => Effect.succeed(fallback)),
	)
}
