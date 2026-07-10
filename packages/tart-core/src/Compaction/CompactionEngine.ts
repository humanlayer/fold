/**
 * This file is the pure auto-compaction engine (D11): the threshold arithmetic over API-reported
 * usage, the interim per-model context windows (until ModelCatalog owns limits - D15), the
 * chars/4 token estimate and keep-recent cut-point selection over projected messages (pi's
 * compaction shape), the transcript serialization the summarizer reads, and the provider-overflow
 * error classifier for the reactive path. Everything here is data-in/data-out; the Compaction
 * service and the agent loop orchestrate around it.
 */
import type { LogEntry } from '../EventLog/Schemas'
import { usageInputTotal, usageOutputTotal, type UsageEncoded } from '../EventLog/Usage'
import type { ProjectedMessage } from '../Projection/Projection'

/** Reserve kept free below the usable budget so compaction fires before requests fail (pi default). */
export const defaultReserveTokens = 16_384

/** Recent-message tail kept verbatim out of the summary (pi default). */
export const defaultKeepRecentTokens = 20_000

/** Output allowance subtracted from the context window; both pi and opencode cap output near 32k. */
export const maxOutputTokenBudget = 32_000

/** Context window assumed for models the interim table does not recognize. */
export const fallbackContextWindow = 128_000

/** Tool results are truncated to this many characters in the summarizer's transcript (pi). */
export const serializedToolResultMaxChars = 2_000

/** Flat character weight for image/file parts in the token estimate (pi counts images as 4800 chars). */
const filePartEstimateChars = 4_800

/**
 * Interim per-model context windows, pattern-keyed by model id - the same shape as the adaptive
 * thinking table in ModelRequestSettings. Replaced by ModelCatalog data when it lands (D15). An
 * agent's `autoCompact.contextWindow` overrides the lookup entirely.
 */
export const defaultModelContextWindows: ReadonlyArray<readonly [RegExp, number]> = [
	[/claude|fable|mythos/, 200_000],
	[/gpt-5|codex/, 272_000],
	[/gpt-4\.1/, 1_000_000],
]

/** Context window for one model id via the interim table; unknown models get the fallback. */
export const defaultContextWindowFor = (modelId: string | null): number => {
	if (modelId === null) return fallbackContextWindow

	const id = modelId.toLowerCase()
	const match = defaultModelContextWindows.find(([pattern]) => pattern.test(id))

	return match === undefined ? fallbackContextWindow : match[1]
}

/**
 * Tokens the conversation may occupy before compaction fires: the context window minus the output
 * allowance and the reserve (D11's formula). Both subtractions are clamped to fractions of the
 * window so tiny configured windows (tests, forced-compaction demos) still leave a positive budget.
 */
export const compactionUsableTokens = (input: {
	readonly contextWindow: number
	readonly reserveTokens: number
}): number => {
	const outputBudget = Math.min(maxOutputTokenBudget, Math.floor(input.contextWindow / 4))
	const reserve = Math.min(input.reserveTokens, Math.floor(input.contextWindow / 8))

	return Math.max(1, input.contextWindow - outputBudget - reserve)
}

/**
 * Fold one API-reported usage into a context-size estimate: total input (the anthropic and openai
 * providers both fold cache reads/writes into `inputTokens.total`) plus output. Null when the
 * provider reported nothing useful - a null estimate never triggers compaction.
 */
export const contextTokensFromUsage = (usage: UsageEncoded): number | null => {
	const input = usageInputTotal(usage)
	const output = usageOutputTotal(usage)
	const total = input + output

	return total > 0 ? total : null
}

/**
 * The last API-reported context size for an agent, from the newest assistant entry recorded AFTER
 * the latest compaction. Assistant usage recorded before a compaction measured the pre-compaction
 * context, so it must never re-trigger (pi's stale-usage guard); until a fresh response reports
 * post-compaction usage there is nothing trustworthy to compare - which is also the progress guard:
 * one compaction per reported response, never two without a new response in between.
 */
export const latestReportedContextTokens = (visibleEntries: ReadonlyArray<LogEntry>): number | null => {
	const compactionSeq = visibleEntries.findLast((entry) => entry._tag === 'compaction')?.seq ?? -1

	for (let index = visibleEntries.length - 1; index >= 0; index -= 1) {
		const entry = visibleEntries[index]
		if (entry === undefined || entry._tag !== 'assistant-message' || entry.seq <= compactionSeq) continue
		if (entry.finish === null) continue

		return contextTokensFromUsage(entry.finish.usage)
	}

	return null
}

type EncodedPart = {
	readonly type: string
	readonly text?: string
	readonly name?: string
	readonly params?: unknown
	readonly result?: unknown
	readonly isFailure?: boolean
}

const safeStringify = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return String(value)
	}
}

const contentParts = (content: unknown): ReadonlyArray<EncodedPart> => {
	if (typeof content === 'string') return [{ type: 'text', text: content }]
	if (!Array.isArray(content)) return []

	return content.filter(
		(part): part is EncodedPart => typeof part === 'object' && part !== null && typeof part.type === 'string',
	)
}

const estimatePartChars = (part: EncodedPart): number => {
	switch (part.type) {
		case 'text':
		case 'reasoning':
			return part.text?.length ?? 0
		case 'file':
			return filePartEstimateChars
		case 'tool-call':
			return (part.name?.length ?? 0) + safeStringify(part.params).length
		case 'tool-result':
			return safeStringify(part.result).length
		default:
			return safeStringify(part).length
	}
}

/** Estimate one projected message's token footprint (chars/4 heuristic; image parts weigh 4800 chars). */
export const estimateMessageTokens = (message: ProjectedMessage): number => {
	if (message._tag === 'compaction-summary') return Math.max(1, Math.ceil(message.summary.length / 4))

	const chars =
		message._tag === 'system-message'
			? message.messages.reduce((total, systemMessage) => total + systemMessage.content.length, 0)
			: contentParts(message.message.content).reduce((total, part) => total + estimatePartChars(part), 0)

	return Math.max(1, Math.ceil(chars / 4))
}

/** A message where a compaction cut may land: the first KEPT message must open a coherent exchange. */
const isValidCutMessage = (message: ProjectedMessage): boolean =>
	message._tag === 'user-message' || message._tag === 'assistant-message'

/**
 * Choose the compaction cut over an agent's conversation messages: walking back from the newest,
 * keep roughly `keepRecentTokens` of recent context verbatim and summarize everything older. The
 * returned index is the first KEPT message; everything before it is summarized. A cut never lands
 * on a tool-result - a tool result must stay in the same region as the assistant tool call that
 * produced it - so the cut slides to the nearest user/assistant boundary (preferring to keep more
 * when none exists at or after the budget boundary). Returns 0 when there is nothing to summarize.
 */
export const findCompactionCut = (messages: ReadonlyArray<ProjectedMessage>, keepRecentTokens: number): number => {
	if (messages.length === 0) return 0

	let accumulated = 0
	let boundary = -1
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message === undefined) continue

		accumulated += estimateMessageTokens(message)
		if (accumulated >= keepRecentTokens) {
			boundary = index
			break
		}
	}

	// The whole conversation fits inside the keep budget: nothing old enough to summarize.
	if (boundary <= 0) return 0

	for (let index = boundary; index < messages.length; index += 1) {
		const message = messages[index]
		if (message !== undefined && isValidCutMessage(message)) return index
	}

	for (let index = boundary - 1; index > 0; index -= 1) {
		const message = messages[index]
		if (message !== undefined && isValidCutMessage(message)) return index
	}

	return 0
}

const serializeUserContent = (content: unknown): string =>
	contentParts(content)
		.map((part) => {
			switch (part.type) {
				case 'text':
					return part.text ?? ''
				case 'file':
					return '[attached file]'
				default:
					return safeStringify(part)
			}
		})
		.join('\n')

const truncateToolResult = (serialized: string): string =>
	serialized.length <= serializedToolResultMaxChars
		? serialized
		: `${serialized.slice(0, serializedToolResultMaxChars)}[... ${serialized.length - serializedToolResultMaxChars} more characters truncated]`

/**
 * Flatten the messages being replaced into the plain-text transcript the summarizer reads (pi's
 * `serializeConversation` shape). Text form keeps the summarization request provider-neutral - no
 * dangling tool-call pairs to violate provider message rules - and tool results are truncated so
 * one huge output cannot blow the summarizer's own context.
 */
export const serializeConversation = (messages: ReadonlyArray<ProjectedMessage>): string => {
	const lines: Array<string> = []

	for (const message of messages) {
		switch (message._tag) {
			case 'user-message':
				lines.push(`[User]: ${serializeUserContent(message.message.content)}`)
				break

			case 'assistant-message': {
				const parts = contentParts(message.message.content)
				const reasoning = parts.filter((part) => part.type === 'reasoning')
				const text = parts.filter((part) => part.type === 'text')
				const toolCalls = parts.filter((part) => part.type === 'tool-call')

				for (const part of reasoning) {
					lines.push(`[Assistant thinking]: ${part.text ?? ''}`)
				}
				if (text.length > 0) {
					lines.push(`[Assistant]: ${text.map((part) => part.text ?? '').join('\n')}`)
				}
				if (toolCalls.length > 0) {
					lines.push(
						`[Assistant tool calls]: ${toolCalls
							.map((part) => `${part.name ?? 'tool'}(${safeStringify(part.params)})`)
							.join('; ')}`,
					)
				}
				break
			}

			case 'tool-result':
				for (const part of contentParts(message.message.content)) {
					if (part.type !== 'tool-result') continue
					lines.push(`[Tool result]: ${truncateToolResult(safeStringify(part.result))}`)
				}
				break

			case 'system-message':
				// Only inline system notes reach serialization; the leading block set is config, not
				// conversation, and the caller excludes it.
				for (const systemMessage of message.messages) {
					lines.push(`[System note]: ${systemMessage.content}`)
				}
				break

			case 'compaction-summary':
				// Excluded by the caller: the previous summary travels in <previous-summary> instead.
				break
		}
	}

	return lines.join('\n')
}

/**
 * Provider messages that mean "this request exceeded the model's context window" (union of the
 * load-bearing pi and opencode patterns). The reactive path compacts and retries once on these
 * instead of failing the run.
 */
export const contextOverflowPatterns: ReadonlyArray<RegExp> = [
	/context[_ ]length[_ ]exceeded/i,
	/model_context_window_exceeded/i,
	/prompt is too long/i,
	/input is too long/i,
	/exceeds the context window/i,
	/maximum context length/i,
	/maximum prompt length/i,
	/context window exceeds/i,
	/exceeds the available context/i,
	/reduce the length of the messages/i,
	/request entity too large/i,
	/too large for model/i,
]

/** Messages that must never be treated as overflow even when a broad pattern matches (pi's guard). */
const nonOverflowPatterns: ReadonlyArray<RegExp> = [/rate.?limit/i, /too many requests/i, /quota/i]

/** True when a provider failure message reads as a context-window overflow. */
export const isContextOverflowError = (message: string): boolean =>
	!nonOverflowPatterns.some((pattern) => pattern.test(message)) &&
	contextOverflowPatterns.some((pattern) => pattern.test(message))
