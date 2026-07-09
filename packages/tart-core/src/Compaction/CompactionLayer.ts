/**
 * This file builds the live Compaction service from one agent definition's `autoCompact` config
 * (D11). The live service is pure policy plus one summarization call: `shouldCompact` compares the
 * agent's last post-compaction API-reported usage against the model's usable budget, and `plan`
 * picks the keep-recent cut over the agent's projected conversation, serializes the replaced
 * history, runs the summarizer through the AMBIENT LanguageModel (each agent's own provisioned
 * model - subagents therefore summarize with their own model, D21), and returns the durable entry
 * payload. The session facade provides this service session-wide; the loop owns appends.
 */
import { Effect, Stream } from 'effect'
import { LanguageModel, Prompt } from 'effect/unstable/ai'

import { entriesForAgent, messagesForAgent, type ProjectedMessage } from '../Projection/Projection'
import {
	compactionUsableTokens,
	defaultContextWindowFor,
	defaultKeepRecentTokens,
	defaultReserveTokens,
	findCompactionCut,
	latestReportedContextTokens,
	serializeConversation,
} from './CompactionEngine'
import { buildCompactionRequestText, compactionSystemPrompt } from './CompactionPrompts'
import {
	CompactionSummarizeError,
	noopCompaction,
	type AutoCompactConfig,
	type CompactionCheckInput,
	type CompactionPlan,
	type CompactionPlanInput,
	type CompactionService,
} from './CompactionService'

/** The enabled variant of {@link AutoCompactConfig}. */
export type EnabledAutoCompactConfig = Extract<AutoCompactConfig, { readonly enabled: true }>

const describeSummarizerError = (error: unknown): string => {
	if (error instanceof Error) return error.message

	try {
		return JSON.stringify(error)
	} catch {
		return String(error)
	}
}

/** Split an agent's projection into the summarizable conversation and its current summary, if any. */
const conversationOf = (
	projected: ReadonlyArray<ProjectedMessage>,
): { readonly conversation: ReadonlyArray<ProjectedMessage>; readonly previousSummary: string | null } => {
	let previousSummary: string | null = null
	const conversation: Array<ProjectedMessage> = []

	for (const message of projected) {
		// The leading block set is configuration, not conversation: it survives compaction untouched
		// (projection re-inserts it above the summary), so it is neither summarized nor kept-counted.
		if (message._tag === 'system-message' && message.placement === 'leading') continue

		if (message._tag === 'compaction-summary') {
			previousSummary = message.summary
			continue
		}

		conversation.push(message)
	}

	return { conversation, previousSummary }
}

/** Build the live Compaction service for one enabled config. */
export const makeCompactionService = (config: EnabledAutoCompactConfig): CompactionService => {
	const reserveTokens = config.reserveTokens ?? defaultReserveTokens

	const contextWindowFor = (input: CompactionCheckInput): number =>
		config.contextWindow ?? defaultContextWindowFor(input.model?.modelId ?? null)
	const thresholdFor = (input: CompactionCheckInput): number =>
		config.thresholdTokens ?? compactionUsableTokens({ contextWindow: contextWindowFor(input), reserveTokens })

	const shouldCompact = Effect.fn('tart.compaction.should_compact')((input: CompactionCheckInput) =>
		Effect.sync(() => {
			const visible = entriesForAgent(input.entries, input.agentId)
			const tokens = latestReportedContextTokens(visible)
			if (tokens === null) return false

			return tokens >= thresholdFor(input)
		}),
	)

	const plan = Effect.fn('tart.compaction.plan')((input: CompactionPlanInput) =>
		Effect.gen(function* () {
			const visible = entriesForAgent(input.entries, input.agentId)
			const projected = messagesForAgent(input.entries, input.agentId)
			const { conversation, previousSummary } = conversationOf(projected)

			// Clamp the kept tail to a fraction of the usable budget so a compaction always frees
			// meaningful space, even under tiny configured windows.
			const usable = thresholdFor(input)
			const keepRecentTokens = Math.min(
				config.keepRecentTokens ?? defaultKeepRecentTokens,
				Math.max(1, Math.floor(usable / 4)),
			)

			const cut = findCompactionCut(conversation, keepRecentTokens)
			if (cut <= 0) return null

			const toSummarize = conversation.slice(0, cut)
			const lastReplaced = toSummarize[toSummarize.length - 1]
			if (lastReplaced === undefined) return null

			yield* Effect.annotateCurrentSpan({
				trigger: input.trigger,
				replacedMessages: toSummarize.length,
				keptMessages: conversation.length - toSummarize.length,
			})

			const requestText = buildCompactionRequestText({
				conversationText: serializeConversation(toSummarize),
				previousSummary,
				customPrompt: config.compactionPrompt ?? null,
			})

			const languageModel = yield* LanguageModel.LanguageModel
			const parts = yield* Stream.runCollect(
				languageModel.streamText({
					prompt: Prompt.fromMessages([
						Prompt.systemMessage({ content: compactionSystemPrompt }),
						Prompt.userMessage({ content: [Prompt.textPart({ text: requestText })] }),
					]),
				}),
			).pipe(
				Effect.mapError((error) => new CompactionSummarizeError({ message: describeSummarizerError(error) })),
			)

			const summary = parts
				.flatMap((part) => (part.type === 'text-delta' ? [part.delta] : []))
				.join('')
				.trim()

			if (summary.length === 0) {
				return yield* new CompactionSummarizeError({ message: 'the summarization call produced no text' })
			}

			const compactionPlan: CompactionPlan = {
				summary,
				replacesThroughSeq: lastReplaced.sourceSeq,
				tokensBefore: latestReportedContextTokens(visible) ?? 0,
			}

			return compactionPlan
		}),
	)

	return { enabled: true, shouldCompact, plan }
}

/** Resolve an agent definition's `autoCompact` config to the service the session should install. */
export const compactionServiceFor = (config: AutoCompactConfig | undefined): CompactionService =>
	config === undefined || !config.enabled ? noopCompaction : makeCompactionService(config)
