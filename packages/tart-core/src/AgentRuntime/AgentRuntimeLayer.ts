/**
 * This file implements the live AgentRuntime layer - the imperative model loop for one agent. Each run
 * appends the user message, then loops turns: project messages from the EventLog, build the prompt,
 * apply preRequest hooks, call the LanguageModel, persist the assistant message with tart tool-call
 * ids (stashing provider ids in part options), settle tool calls through ToolRuntime, and consult
 * onComplete hooks before writing the terminal agent-finished entry. Model provider failures become
 * durable error + agent-finished entries, never service failures.
 */
import { Effect, Layer, Ref, Result, Schema, Stream } from 'effect'
import { LanguageModel, Prompt, Response } from 'effect/unstable/ai'

import { EventLog } from '../EventLog/EventLogService'
import type { AgentFinishedLogEntry, AgentFinishedOutcome, LogEntry, LogEntryInput } from '../EventLog/Schemas'
import { HookRunner } from '../HookRunner/HookRunnerService'
import { Ids } from '../Ids'
import { buildPrompt, providerToolCallIdKey, tartPartOptionsKey } from '../Model/RequestBuilder'
import { messagesForAgent } from '../Projection/Projection'
import { StopController, type StopControllerService } from '../ToolRuntime/ToolContextServices'
import { ToolRuntime } from '../ToolRuntime/ToolRuntimeService'
import { Toolset } from '../ToolRuntime/ToolsetService'
import { AgentRuntime, type AgentRuntimeService, type RunAgentInput, type StartAgentInput } from './AgentRuntimeService'

const encodeSystemMessage = Schema.encodeUnknownSync(Prompt.SystemMessage)
const encodeUserMessage = Schema.encodeUnknownSync(Prompt.UserMessage)
const encodeAssistantMessage = Schema.encodeUnknownSync(Prompt.AssistantMessage)
const encodeUsage = Schema.encodeUnknownSync(Response.Usage)

/** Result of one private model/tool turn. */
type TurnResult = { readonly _tag: 'finished'; readonly entry: AgentFinishedLogEntry } | { readonly _tag: 'continue' }

/** Derive a short human-readable message from a model provider failure. */
const describeModelError = (error: unknown): string => {
	if (error instanceof Error) return error.message

	try {
		return JSON.stringify(error)
	} catch {
		return String(error)
	}
}

/** Concatenate the text parts of an assistant message, or null when it produced no text. */
const assistantResultText = (message: Prompt.AssistantMessage): string | null => {
	const text = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')

	return text.length > 0 ? text : null
}

/** Live AgentRuntime layer wiring the EventLog, hooks, model, and tool settlement into the loop. */
export const liveAgentRuntimeLayer: Layer.Layer<
	AgentRuntime,
	never,
	EventLog | Ids | HookRunner | Toolset | ToolRuntime | LanguageModel.LanguageModel
> = Layer.effect(
	AgentRuntime,
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids
		const hooks = yield* HookRunner
		const toolset = yield* Toolset
		const toolRuntime = yield* ToolRuntime
		const languageModel = yield* LanguageModel.LanguageModel

		const appendToEventLog = (input: LogEntryInput): Effect.Effect<LogEntry> =>
			eventLog.append(input).pipe(Effect.orDie)

		const collectEntries: Effect.Effect<ReadonlyArray<LogEntry>> = Stream.runCollect(eventLog.entries()).pipe(
			Effect.orDie,
			Effect.map((entries): ReadonlyArray<LogEntry> => entries),
		)

		const appendUserMessage = (input: RunAgentInput, text: string): Effect.Effect<void> =>
			ids.makeMessageId.pipe(
				Effect.flatMap((messageId) =>
					appendToEventLog({
						_tag: 'user-message',
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						toolCallId: input.toolCallId,
						messageId,
						message: encodeUserMessage(Prompt.userMessage({ content: [Prompt.textPart({ text })] })),
					}),
				),
				Effect.asVoid,
			)

		const appendFinished = (
			input: RunAgentInput,
			outcome: AgentFinishedOutcome,
			resultText: string | null,
			reason: string | null,
		): Effect.Effect<AgentFinishedLogEntry> =>
			Effect.gen(function* () {
				const entry = yield* appendToEventLog({
					_tag: 'agent-finished',
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCallId: input.toolCallId,
					outcome,
					resultText,
					reason,
				})

				if (entry._tag === 'agent-finished') return entry

				// Invariant!
				return yield* Effect.die(new Error(`EventLog returned ${entry._tag} while appending agent-finished`))
			})

		/** Rewrite provider tool-call ids to freshly minted tart ids, stashing the provider id per part. */
		const rewriteAssistantToolCallIds = (
			message: Prompt.AssistantMessage,
		): Effect.Effect<Prompt.AssistantMessage> =>
			Effect.gen(function* () {
				const content: Array<Prompt.AssistantMessage['content'][number]> = []

				for (const part of message.content) {
					if (part.type !== 'tool-call') {
						content.push(part)
						continue
					}

					const tartId = yield* ids.makeToolCallId
					content.push(
						Prompt.toolCallPart({
							...part,
							id: tartId,
							options: { ...part.options, [tartPartOptionsKey]: { [providerToolCallIdKey]: part.id } },
						}),
					)
				}

				return Prompt.assistantMessage({ content, options: message.options })
			})

		/** Run one model turn: build the request, call the model, persist, and settle tool calls. */
		const runTurn = (
			input: RunAgentInput,
			stopController: StopControllerService,
			stopRef: Ref.Ref<string | null>,
		): Effect.Effect<TurnResult> =>
			Effect.gen(function* () {
				const entries = yield* collectEntries
				const projected = messagesForAgent(entries, input.agentId)
				const prompt = yield* buildPrompt(projected).pipe(Effect.orDie)

				// Hook typed failures are resolved at authorship (D16); an escaped HookExecutionError is a
				// defect here. preRequest/onComplete defect policy is owned by the in-flight defect work.
				const preRequestDecision = yield* hooks
					.preRequest({ agentId: input.agentId, parentAgentId: input.parentAgentId, prompt })
					.pipe(Effect.provideService(StopController, stopController), Effect.orDie)

				const requestPrompt = preRequestDecision._tag === 'changed' ? preRequestDecision.prompt : prompt

				const stopReasonAfterPreRequest = yield* Ref.get(stopRef)
				if (stopReasonAfterPreRequest !== null) {
					const entry = yield* appendFinished(input, 'stopped', null, stopReasonAfterPreRequest)
					return { _tag: 'finished', entry } as const
				}

				const toolkit = yield* toolset.withHandler
				const modelParts = yield* Stream.runCollect(
					languageModel.streamText({ prompt: requestPrompt, toolkit, disableToolCallResolution: true }),
				).pipe(Effect.result)

				if (Result.isFailure(modelParts)) {
					const message = describeModelError(modelParts.failure)

					yield* appendToEventLog({
						_tag: 'error',
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						toolCallId: input.toolCallId,
						errorType: 'model',
						message,
						details: {},
					})

					const entry = yield* appendFinished(input, 'error', null, message)
					return { _tag: 'finished', entry } as const
				}

				const parts: ReadonlyArray<Response.AnyPart> = modelParts.success
				const finishPart = parts.findLast((part): part is Response.FinishPart => part.type === 'finish')
				const responseMessages = Prompt.fromResponseParts(parts)
				const assistantMessage = responseMessages.content.find(
					(message): message is Prompt.AssistantMessage => message.role === 'assistant',
				)

				if (assistantMessage === undefined) {
					const entry = yield* appendFinished(input, 'completed', null, null)
					return { _tag: 'finished', entry } as const
				}

				const persistedAssistant = yield* rewriteAssistantToolCallIds(assistantMessage)

				yield* appendToEventLog({
					_tag: 'assistant-message',
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCallId: input.toolCallId,
					messageId: yield* ids.makeMessageId,
					message: encodeAssistantMessage(persistedAssistant),
					finish:
						finishPart === undefined
							? null
							: { reason: finishPart.reason, usage: encodeUsage(finishPart.usage) },
				})

				const hasToolCalls = persistedAssistant.content.some((part) => part.type === 'tool-call')

				if (hasToolCalls) {
					const settlement = yield* toolRuntime.settle({
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						assistantMessage: persistedAssistant,
					})

					if (settlement.stopRequested) {
						const entry = yield* appendFinished(input, 'stopped', null, 'a tool or hook requested a stop')
						return { _tag: 'finished', entry } as const
					}

					return { _tag: 'continue' } as const
				}

				const resultText = assistantResultText(persistedAssistant)

				const onCompleteDecision = yield* hooks
					.onComplete({ agentId: input.agentId, parentAgentId: input.parentAgentId, resultText })
					.pipe(Effect.provideService(StopController, stopController), Effect.orDie)

				const stopReasonAfterComplete = yield* Ref.get(stopRef)
				if (stopReasonAfterComplete !== null) {
					const entry = yield* appendFinished(input, 'stopped', resultText, stopReasonAfterComplete)
					return { _tag: 'finished', entry } as const
				}

				if (onCompleteDecision._tag === 'continueWith') {
					yield* appendUserMessage(input, onCompleteDecision.text)
					return { _tag: 'continue' } as const
				}

				const entry = yield* appendFinished(input, 'completed', resultText, null)
				return { _tag: 'finished', entry } as const
			})

		const start: AgentRuntimeService['start'] = Effect.fn('tart.agent_runtime.start')((input: StartAgentInput) =>
			Effect.gen(function* () {
				const tools = yield* toolset.names

				const entry = yield* appendToEventLog({
					_tag: 'agent_started',
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCallId: input.toolCallId,
					mode: 'fresh',
					model: input.model,
					tools,
					skill: null,
					fork: null,
				})

				if (input.systemPrompt !== null) {
					yield* appendToEventLog({
						_tag: 'system-message',
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						toolCallId: input.toolCallId,
						messageId: yield* ids.makeMessageId,
						message: encodeSystemMessage(Prompt.systemMessage({ content: input.systemPrompt })),
						placement: 'leading',
					})
				}

				if (entry._tag === 'agent_started') return entry

				// Invariant!
				return yield* Effect.die(new Error(`EventLog returned ${entry._tag} while appending agent_started`))
			}),
		)

		const run: AgentRuntimeService['run'] = Effect.fn('tart.agent_runtime.run')((input: RunAgentInput) =>
			Effect.gen(function* () {
				const stopRef = yield* Ref.make<string | null>(null)
				const stopController: StopControllerService = {
					requestStop: (reason) => Ref.set(stopRef, reason),
					isStopRequested: Ref.get(stopRef).pipe(Effect.map((reason) => reason !== null)),
				}

				yield* appendUserMessage(input, input.text)

				while (true) {
					const turn = yield* runTurn(input, stopController, stopRef)
					if (turn._tag === 'finished') return turn.entry
				}
			}),
		)

		return { start, run }
	}),
)
