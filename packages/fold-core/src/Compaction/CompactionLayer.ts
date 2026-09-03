/**
 * This file builds the live Compaction service from one agent definition's `autoCompact` config
 * (D11). The live service is pure policy plus one summarization call: `shouldCompact` compares the
 * agent's last post-compaction API-reported usage against the model's usable budget, and `plan`
 * picks the keep-recent cut over the agent's projected conversation, serializes the replaced
 * history, runs the summarizer through the AMBIENT LanguageModel (each agent's own provisioned
 * model - subagents therefore summarize with their own model, D21), and returns the durable entry
 * payload. The session facade provides this service session-wide; the loop owns appends.
 */
import { AnthropicLanguageModel } from '@humanlayer/effect-ai-anthropic'
import { OpenAiLanguageModel } from '@humanlayer/effect-ai-openai'
import { Effect, Predicate, Stream } from 'effect'
import { LanguageModel, Prompt } from 'effect/unstable/ai'

import { ModelCatalog } from '../Model/ModelCatalog'
import { entriesForAgent, messagesForAgent, type ProjectedMessage } from '../Projection/Projection'
import {
	compactionUsableTokens,
	defaultContextWindowFor,
	defaultKeepRecentTokens,
	defaultReserveTokens,
	findCompactionCutPlan,
	latestReportedContextTokens,
	maxOutputTokenBudget,
	serializeConversation,
} from './CompactionEngine'
import {
	buildCompactionRequestText,
	compactionInstruction,
	compactionSystemPrompt,
	turnPrefixCompactionPrompt,
} from './CompactionPrompts'
import {
	CompactionSummarizeError,
	type AutoCompactConfig,
	type CompactionCheckInput,
	type CompactionPlan,
	type CompactionPlanInput,
	type CompactionService,
} from './CompactionService'

/** The enabled variant of {@link AutoCompactConfig}. */
export type EnabledAutoCompactConfig = Extract<AutoCompactConfig, { readonly enabled: true }>

const describeSummarizerError = (error: unknown): string => {
	if (Predicate.isError(error)) return error.message

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
		if (Predicate.isTagged(message, 'system-message') && message.placement === 'leading') continue

		if (Predicate.isTagged(message, 'compaction-summary')) {
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
	const summaryOutputFraction = 0.8
	const turnPrefixOutputFraction = 0.5

	/**
	 * Resolve the agent's context window: an explicit `autoCompact.contextWindow` always wins, then
	 * the session's ModelCatalog entry for the active model, then the interim pattern table (D15).
	 * The Reference default is the empty catalog, so this adds nothing to the effect requirements.
	 */
	const contextWindowFor = (input: CompactionCheckInput): Effect.Effect<number> =>
		Effect.gen(function* () {
			if (config.contextWindow !== undefined) return config.contextWindow

			const entry = input.model === null ? null : yield* (yield* ModelCatalog).lookup(input.model)

			return entry?.contextWindow ?? defaultContextWindowFor(input.model?.modelId ?? null)
		})

	const thresholdFor = (input: CompactionCheckInput): Effect.Effect<number> =>
		config.thresholdTokens !== undefined
			? Effect.succeed(config.thresholdTokens)
			: contextWindowFor(input).pipe(
					Effect.map((contextWindow) => compactionUsableTokens({ contextWindow, reserveTokens })),
				)

	const modelOutputLimitFor = (input: CompactionCheckInput): Effect.Effect<number> =>
		Effect.gen(function* () {
			const entry = input.model === null ? null : yield* (yield* ModelCatalog).lookup(input.model)
			return entry !== null && entry.maxOutputTokens > 0 ? entry.maxOutputTokens : maxOutputTokenBudget
		})

	const summarize = (
		input: CompactionPlanInput,
		requestText: string,
		outputFraction: number,
	): Effect.Effect<string, CompactionSummarizeError, LanguageModel.LanguageModel> =>
		Effect.gen(function* () {
			const modelOutputLimit = yield* modelOutputLimitFor(input)
			const maxOutputTokens = Math.min(Math.floor(outputFraction * reserveTokens), modelOutputLimit)
			const languageModel = yield* LanguageModel.LanguageModel
			const baseRequest = Stream.runCollect(
				languageModel.streamText({
					prompt: Prompt.fromMessages([
						Prompt.systemMessage({ content: compactionSystemPrompt }),
						Prompt.userMessage({ content: [Prompt.textPart({ text: requestText })] }),
					]),
				}),
			)
			let configuredRequest = baseRequest
			if (input.model?.providerKind === 'anthropic') {
				configuredRequest = baseRequest.pipe(
					AnthropicLanguageModel.withConfigOverride({ max_tokens: maxOutputTokens }),
				)
			} else if (input.model?.providerKind !== 'codex') {
				configuredRequest = baseRequest.pipe(
					OpenAiLanguageModel.withConfigOverride({ max_output_tokens: maxOutputTokens }),
				)
			}
			const request = configuredRequest.pipe(
				Effect.mapError((error) => new CompactionSummarizeError({ message: describeSummarizerError(error) })),
			)
			const parts = yield* request
			const summary = parts
				.flatMap((part) => (part.type === 'text-delta' ? [part.delta] : []))
				.join('')
				.trim()

			if (summary.length === 0) {
				return yield* new CompactionSummarizeError({ message: 'the summarization call produced no text' })
			}

			return summary
		})

	const shouldCompact = Effect.fn('fold.compaction.should_compact')((input: CompactionCheckInput) =>
		Effect.gen(function* () {
			const visible = entriesForAgent(input.entries, input.agentId)
			const tokens = latestReportedContextTokens(visible)
			if (tokens === null) return false

			return tokens >= (yield* thresholdFor(input))
		}),
	)

	const plan = Effect.fn('fold.compaction.plan')((input: CompactionPlanInput) =>
		Effect.gen(function* () {
			const visible = entriesForAgent(input.entries, input.agentId)
			const projected = messagesForAgent(input.entries, input.agentId)
			const { conversation, previousSummary } = conversationOf(projected)

			// Clamp the kept tail to a fraction of the usable budget so a compaction always frees
			// meaningful space, even under tiny configured windows.
			const usable = yield* thresholdFor(input)
			const keepRecentTokens = Math.min(
				config.keepRecentTokens ?? defaultKeepRecentTokens,
				Math.max(1, Math.floor(usable / 4)),
			)

			const cut = findCompactionCutPlan(conversation, keepRecentTokens)
			const summarizeCompleteConversation =
				input.trigger === 'manual' && cut.firstKeptIndex <= 0 && conversation.length >= 2
			if (cut.firstKeptIndex <= 0 && !summarizeCompleteConversation) return null

			const firstKeptIndex = summarizeCompleteConversation ? conversation.length : cut.firstKeptIndex
			const historyEnd = summarizeCompleteConversation
				? conversation.length
				: cut.isSplitTurn
					? cut.turnStartIndex
					: firstKeptIndex
			const toSummarize = conversation.slice(0, historyEnd)
			const turnPrefix = cut.isSplitTurn ? conversation.slice(cut.turnStartIndex, firstKeptIndex) : []
			const discarded = conversation.slice(0, firstKeptIndex)
			const firstDiscarded = discarded[0]
			if (firstDiscarded === undefined) return null
			// Projected tool results can be reordered into their assistant call order while retaining
			// physical event-log sequences. The durable cutoff applies to physical sequence order, so it
			// must cover every discarded message rather than the final message in the projected order.
			const replacesThroughSeq = discarded.reduce(
				(maximum, message) => Math.max(maximum, message.sourceSeq),
				firstDiscarded.sourceSeq,
			)

			yield* Effect.annotateCurrentSpan({
				trigger: input.trigger,
				replacedMessages: discarded.length,
				keptMessages: conversation.length - discarded.length,
				splitTurn: cut.isSplitTurn,
				summaryCalls: cut.isSplitTurn ? (toSummarize.length > 0 ? 2 : 1) : 1,
			})

			const requestText = buildCompactionRequestText({
				conversationText: serializeConversation(toSummarize),
				previousSummary,
				customPrompt: config.compactionPrompt ?? null,
				additionalInstructions: input.additionalInstructions ?? null,
			})
			const prompt = compactionInstruction({
				previousSummary,
				customPrompt: config.compactionPrompt ?? null,
				additionalInstructions: input.additionalInstructions ?? null,
			})

			const historySummary =
				toSummarize.length > 0
					? yield* summarize(input, requestText, summaryOutputFraction)
					: 'No prior history.'
			const summary = cut.isSplitTurn
				? `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${yield* summarize(
						input,
						buildCompactionRequestText({
							conversationText: serializeConversation(turnPrefix),
							previousSummary: null,
							customPrompt: turnPrefixCompactionPrompt,
						}),
						turnPrefixOutputFraction,
					)}`
				: historySummary

			const compactionPlan: CompactionPlan = {
				prompt,
				summary,
				replacesThroughSeq,
				tokensBefore: latestReportedContextTokens(visible) ?? 0,
			}

			return compactionPlan
		}),
	)

	return { enabled: true, shouldCompact, plan }
}

/** Resolve an agent definition's automatic policy while retaining an explicit compaction planner. */
export const compactionServiceFor = (config: AutoCompactConfig | undefined): CompactionService => {
	const live = makeCompactionService(config?.enabled === true ? config : { enabled: true })
	if (config?.enabled !== false) return live

	return { ...live, enabled: false, shouldCompact: () => Effect.succeed(false) }
}
