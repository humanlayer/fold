/**
 * This file implements the live AgentRuntime layer - the imperative model loop for one agent. Each run
 * appends the user message, then loops turns: drain steering, run the top-of-turn auto-compaction
 * check (D11), project messages from the EventLog, build the prompt, apply preRequest hooks, call the
 * LanguageModel, persist the assistant message with tart tool-call ids (stashing provider ids in part
 * options), settle tool calls through ToolRuntime, and consult onComplete hooks before writing the
 * terminal agent-finished entry. Provider context-overflow failures take the reactive compaction path
 * (compact and restart the turn, once per run) before becoming durable error outcomes. While the model streams, each
 * text/reasoning delta is republished live through AgentEvents so UIs can render output as it arrives;
 * those deltas are ephemeral and never persisted. Model provider failures become durable error +
 * agent-finished entries, never service failures.
 */
import { Array as Arr, Cause, Effect, Exit, Layer, Ref, Result, Schema, Stream } from 'effect'
import { LanguageModel, Prompt, Response } from 'effect/unstable/ai'
import type { Tool, Toolkit } from 'effect/unstable/ai'

import { AgentEvents } from '../AgentEvents/AgentEventsService'
import { CompactionArchiveAccess } from '../Compaction/CompactionArchiveAccess'
import { isContextOverflowError } from '../Compaction/CompactionEngine'
import { Compaction, type CompactionService, type CompactionTrigger } from '../Compaction/CompactionService'
import { EventLog } from '../EventLog/EventLogService'
import type {
	ActiveModel,
	AgentFinishedLogEntry,
	AgentFinishedOutcome,
	CompactionLogEntry,
	LogEntry,
	LogEntryInput,
} from '../EventLog/Schemas'
import { usageFromResponseUsage } from '../EventLog/Usage'
import { HookRunner } from '../HookRunner/HookRunnerService'
import { Ids, type AgentId, type ToolCallId } from '../Ids'
import { ModelCatalog } from '../Model/ModelCatalog'
import { ModelRequestSettings } from '../Model/ModelRequestSettings'
import { buildPrompt, providerToolCallIdKey, tartPartOptionsKey } from '../Model/RequestBuilder'
import { messagesForAgent, runtimeForAgent } from '../Projection/Projection'
import { SessionControls } from '../Session/SessionControls'
import {
	initialDoomLoopState,
	observeDoomLoop,
	StopConditions,
	type DoomLoopState,
} from '../StopConditions/StopConditions'
import { SystemPrompt } from '../SystemPrompt/SystemPromptService'
import { StopController, type StopControllerService } from '../ToolRuntime/ToolContextServices'
import { ToolRuntime } from '../ToolRuntime/ToolRuntimeService'
import { ToolsetResolver } from '../ToolRuntime/ToolsetResolverService'
import { Toolset } from '../ToolRuntime/ToolsetService'
import {
	AgentRuntime,
	type AgentRuntimeService,
	type CompactAgentInput,
	type RunAgentInput,
	type StartAgentInput,
	type SwitchModelInput,
} from './AgentRuntimeService'

const encodeSystemMessage = Schema.encodeUnknownSync(Prompt.SystemMessage)

const anthropicEphemeralCacheControl = { type: 'ephemeral' } as const

const leadingSystemMessageFor = (content: string, cacheBreakpoint: boolean): Prompt.SystemMessage =>
	Prompt.systemMessage({
		content,
		...(cacheBreakpoint
			? {
					options: {
						anthropic: { cacheControl: anthropicEphemeralCacheControl },
					},
				}
			: {}),
	})
const encodeUserMessage = Schema.encodeUnknownSync(Prompt.UserMessage)
const encodeAssistantMessage = Schema.encodeUnknownSync(Prompt.AssistantMessage)

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
	| EventLog
	| Ids
	| HookRunner
	| Toolset
	| ToolsetResolver
	| SystemPrompt
	| ModelRequestSettings
	| ToolRuntime
	| LanguageModel.LanguageModel
	| AgentEvents
	| SessionControls
> = Layer.effect(
	AgentRuntime,
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids
		const hooks = yield* HookRunner
		const toolset = yield* Toolset
		const toolsetResolver = yield* ToolsetResolver
		const systemPrompt = yield* SystemPrompt
		const modelRequestSettings = yield* ModelRequestSettings
		const toolRuntime = yield* ToolRuntime
		const languageModel = yield* LanguageModel.LanguageModel
		const agentEvents = yield* AgentEvents
		const sessionControls = yield* SessionControls
		// Defaulted reference (D11): resolves the session-installed live policy, or the disabled no-op.
		const installedCompaction = yield* Compaction
		// Defaulted reference: host-specific post-compaction archive/log access guidance.
		const compactionArchiveAccess = yield* CompactionArchiveAccess
		// Defaulted reference (D15): the session catalog is captured HERE, at layer construction under
		// the session services, and re-provided around every compaction call - run effects execute on
		// caller fibers whose context lacks session services, so the compaction checks would otherwise
		// resolve the Reference's empty default instead of the installed catalog.
		const modelCatalog = yield* ModelCatalog
		const compaction: CompactionService = {
			enabled: installedCompaction.enabled,
			shouldCompact: (input) =>
				installedCompaction.shouldCompact(input).pipe(Effect.provideService(ModelCatalog, modelCatalog)),
			plan: (input) => installedCompaction.plan(input).pipe(Effect.provideService(ModelCatalog, modelCatalog)),
		}
		const stopConditions = yield* StopConditions

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

		/**
		 * Flush partial assistant text on interrupt (D10): whatever streamed before the interruption is
		 * appended as an ordinary assistant-message, so resume sees coherent, honest history. Runs from an
		 * uninterruptible onExit around the model stream; a turn that completed normally never reaches it.
		 */
		const flushPartialAssistantText = (input: RunAgentInput, partialText: Ref.Ref<string>): Effect.Effect<void> =>
			Effect.gen(function* () {
				const text = yield* Ref.get(partialText)
				if (text.length === 0) return

				yield* appendToEventLog({
					_tag: 'assistant-message',
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCallId: input.toolCallId,
					messageId: yield* ids.makeMessageId,
					message: encodeAssistantMessage(Prompt.assistantMessage({ content: [Prompt.textPart({ text })] })),
					finish: null,
				})
			})

		/**
		 * Run one compaction against the agent's current projection (D11): plan through the Compaction
		 * service - the summarization call runs on this runtime's own LanguageModel, so every agent
		 * (root or subagent) summarizes with its own model - and append the durable `compaction` entry
		 * under this run's envelope. A summarization failure never kills the run: it lands as a durable
		 * `error` note and the turn proceeds uncompacted. Returns the written compaction entry, if any.
		 */
		const performCompaction = (
			input: CompactAgentInput,
			entries: ReadonlyArray<LogEntry>,
			model: ActiveModel | null,
			trigger: CompactionTrigger,
		): Effect.Effect<CompactionLogEntry | null> =>
			Effect.gen(function* () {
				const planned = yield* compaction
					.plan({ agentId: input.agentId, entries, model, trigger })
					.pipe(Effect.provideService(LanguageModel.LanguageModel, languageModel), Effect.result)

				if (Result.isFailure(planned)) {
					yield* appendToEventLog({
						_tag: 'error',
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						toolCallId: input.toolCallId,
						errorType: 'compaction',
						message: planned.failure.message,
						details: { trigger },
					})
					return null
				}

				if (planned.success === null) return null
				const postCompactionInstructions = yield* compactionArchiveAccess.instructions({
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					trigger,
				})

				const entry = yield* appendToEventLog({
					_tag: 'compaction',
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCallId: input.toolCallId,
					compactionId: yield* ids.makeCompactionId,
					summary: planned.success.summary,
					...(postCompactionInstructions === null ? {} : { postCompactionInstructions }),
					replacesThroughSeq: planned.success.replacesThroughSeq,
					tokensBefore: planned.success.tokensBefore,
				})

				if (entry._tag === 'compaction') return entry
				return yield* Effect.die(new Error(`EventLog returned ${entry._tag} while appending compaction`))
			})

		/** Run one model turn: build the request, call the model, persist, and settle tool calls. */
		const runTurn = (
			input: RunAgentInput,
			stopController: StopControllerService,
			stopRef: Ref.Ref<string | null>,
			overflowRecoveryRef: Ref.Ref<boolean>,
			doomLoopRef: Ref.Ref<DoomLoopState>,
		): Effect.Effect<TurnResult> =>
			Effect.gen(function* () {
				// Drain queued steering before this turn's model call (D8): each steered message becomes an
				// ordinary user-message right here, so the log records it exactly where the model saw it.
				const steered = yield* sessionControls.drainSteering(input.agentId)
				for (const text of steered) {
					yield* appendUserMessage(input, text)
				}

				const entriesBeforeCompaction = yield* collectEntries
				const runtimeState = runtimeForAgent(entriesBeforeCompaction, input.agentId)

				// Top-of-turn compaction check (D11): compare the last post-compaction API-reported usage
				// against the model's usable budget, and compact BEFORE building this turn's request so
				// the projection the model sees is the compacted one. Runs identically for root agents
				// and subagents - each against its own projection and its own model's limits (D21).
				const compacted = (yield* compaction.shouldCompact({
					agentId: input.agentId,
					entries: entriesBeforeCompaction,
					model: runtimeState.activeModel,
				}))
					? yield* performCompaction(input, entriesBeforeCompaction, runtimeState.activeModel, 'threshold')
					: false

				const entries = compacted ? yield* collectEntries : entriesBeforeCompaction
				const projected = messagesForAgent(entries, input.agentId)
				const prompt = yield* buildPrompt(projected).pipe(Effect.orDie)

				// Hook typed failures are resolved at authorship (D16); an escaped HookExecutionError is a
				// defect here. preRequest/onComplete defect policy is owned by the in-flight defect work.
				const preRequestDecision = yield* hooks
					.preRequest({ agentId: input.agentId, parentAgentId: input.parentAgentId, prompt })
					.pipe(Effect.provideService(StopController, stopController), Effect.orDie)

				const requestPrompt = preRequestDecision._tag === 'changed' ? preRequestDecision.prompt : prompt

				// Both stop tracks bind before the model call: this run's own StopController (a preRequest
				// hook requested it) and the session-wide signal (D9 - external Session.stop reaches every
				// agent's loop, so the whole tree stops at its batch boundaries).
				const stopReasonAfterPreRequest =
					(yield* Ref.get(stopRef)) ?? (yield* sessionControls.sessionStopReason)
				if (stopReasonAfterPreRequest !== null) {
					const entry = yield* appendFinished(input, 'stopped', null, stopReasonAfterPreRequest)
					return { _tag: 'finished', entry } as const
				}

				// Advertise only the epoch's active toolset (agent_started/tools-change fold): the installed
				// toolkit is filtered to the projected active names, so a tools-change entry binds the very
				// next request. Handlers stay untouched - settlement still executes against the full Toolset.
				const withHandler = yield* toolset.withHandler
				const activeToolEntries = Object.entries(withHandler.tools).filter(([name]) =>
					runtimeState.activeTools.includes(name),
				)
				const toolkit: Toolkit.WithHandler<Record<string, Tool.Any>> = {
					tools: Object.fromEntries(activeToolEntries),
					handle: withHandler.handle,
				}

				// Tap the live model stream: republish each streamed text/reasoning delta as an ephemeral AgentEvents
				// delta so UIs can render output as it arrives. All other part types publish nothing, and deltas never
				// enter the durable log. A failing stream fails before any part, so failure turns publish no deltas.
				// The whole collection runs under the active model request settings, so the provider reads the
				// projected reasoning configuration when it builds the request (thinking-change binds next turn).
				// Text deltas also accumulate outside the interruptible region: if this turn is interrupted
				// mid-stream, the uninterruptible onExit below flushes the partial assistant text durably (D10).
				const partialText = yield* Ref.make('')
				const modelParts = yield* Stream.runCollect(
					languageModel.streamText({ prompt: requestPrompt, toolkit, disableToolCallResolution: true }).pipe(
						Stream.tap((part) =>
							part.type === 'text-delta' || part.type === 'reasoning-delta'
								? agentEvents
										.publish({
											kind: 'delta',
											agentId: input.agentId,
											parentAgentId: input.parentAgentId,
											toolCallId: input.toolCallId,
											part:
												part.type === 'text-delta'
													? { type: 'text-delta', id: part.id, delta: part.delta }
													: { type: 'reasoning-delta', id: part.id, delta: part.delta },
										})
										.pipe(
											Effect.andThen(
												part.type === 'text-delta'
													? Ref.update(partialText, (text) => text + part.delta)
													: Effect.void,
											),
										)
								: Effect.void,
						),
					),
				).pipe(
					modelRequestSettings.wrap({
						model: runtimeState.activeModel,
						reasoningLevel: runtimeState.reasoningLevel,
					}),
					Effect.onExit((exit) =>
						Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
							? flushPartialAssistantText(input, partialText)
							: Effect.void,
					),
					Effect.result,
				)

				if (Result.isFailure(modelParts)) {
					const message = describeModelError(modelParts.failure)

					// Reactive overflow path (D11): when the provider says the request exceeded the context
					// window, compact and restart the turn - once per run. A recovered attempt writes no
					// error entry (transient, like a within-provider retry); a second overflow, or nothing
					// safely compactable, falls through to the durable error outcome below.
					if (
						compaction.enabled &&
						isContextOverflowError(message) &&
						!(yield* Ref.get(overflowRecoveryRef))
					) {
						yield* Ref.set(overflowRecoveryRef, true)
						const recovered = yield* performCompaction(
							input,
							yield* collectEntries,
							runtimeState.activeModel,
							'overflow',
						)
						if (recovered) return { _tag: 'continue' } as const
					}

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
							: { reason: finishPart.reason, usage: usageFromResponseUsage(finishPart.usage) },
				})

				const toolCalls = persistedAssistant.content.flatMap((part) =>
					part.type === 'tool-call' ? [{ name: part.name, params: part.params }] : [],
				)
				const hasToolCalls = toolCalls.length > 0

				if (hasToolCalls) {
					const doomLoop = observeDoomLoop(stopConditions, yield* Ref.get(doomLoopRef), toolCalls)
					yield* Ref.set(doomLoopRef, doomLoop.state)

					const settlement = yield* toolRuntime.settle({
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						assistantMessage: persistedAssistant,
					})

					if (settlement.stopRequested) {
						const entry = yield* appendFinished(input, 'stopped', null, 'a tool or hook requested a stop')
						return { _tag: 'finished', entry } as const
					}

					// D9: a session-wide stop lets the in-flight batch finish and its results land (above),
					// then ends the run here - no further LLM call.
					const sessionStopAfterBatch = yield* sessionControls.sessionStopReason
					if (sessionStopAfterBatch !== null) {
						const entry = yield* appendFinished(input, 'stopped', null, sessionStopAfterBatch)
						return { _tag: 'finished', entry } as const
					}

					if (doomLoop.reason !== null) {
						const entry = yield* appendFinished(input, 'stopped', null, doomLoop.reason)
						return { _tag: 'finished', entry } as const
					}

					return { _tag: 'continue' } as const
				}

				yield* Ref.set(doomLoopRef, initialDoomLoopState)

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

				// D8: follow-ups queued while this agent was running drain exactly where the run would
				// complete naturally - each becomes an ordinary user-message and the run continues.
				const followUps = yield* sessionControls.drainFollowUps(input.agentId)
				if (followUps.length > 0) {
					for (const text of followUps) {
						yield* appendUserMessage(input, text)
					}
					return { _tag: 'continue' } as const
				}

				const entry = yield* appendFinished(input, 'completed', resultText, null)
				return { _tag: 'finished', entry } as const
			})

		/** Shared epoch fields: whose log rows these are, and which model's leading prompt to compose. */
		type LeadingSystemMessageInput = {
			readonly agentId: AgentId
			readonly parentAgentId: AgentId | null
			readonly toolCallId: ToolCallId | null
			readonly model: ActiveModel
			readonly systemPrompt: string | ReadonlyArray<string> | null
		}

		/** Compose and append one epoch's leading system-message block set (agent start and model switch). */
		const appendLeadingSystemMessage = (input: LeadingSystemMessageInput): Effect.Effect<void> =>
			Effect.gen(function* () {
				const agentBlocks =
					input.systemPrompt === null
						? []
						: typeof input.systemPrompt === 'string'
							? [input.systemPrompt]
							: input.systemPrompt

				const blocks = yield* systemPrompt.compose({ model: input.model, agentBlocks })

				if (Arr.isReadonlyArrayNonEmpty(blocks)) {
					yield* appendToEventLog({
						_tag: 'system-message',
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						toolCallId: input.toolCallId,
						messageId: yield* ids.makeMessageId,
						messages: Arr.map(blocks, (content, index) =>
							encodeSystemMessage(leadingSystemMessageFor(content, index === blocks.length - 1)),
						),
						placement: 'leading',
					})
				}
			})

		const start: AgentRuntimeService['start'] = Effect.fn('tart.agent_runtime.start')((input: StartAgentInput) =>
			Effect.gen(function* () {
				// Epoch-open choreography (D17): resolve the family toolset and compose the leading system
				// prompt block set once for the starting model; both are recorded durably.
				const resolvedToolset = yield* toolsetResolver.resolve({ model: input.model })

				const entry = yield* appendToEventLog({
					_tag: 'agent_started',
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCallId: input.toolCallId,
					mode: input.mode,
					model: input.model,
					tools: resolvedToolset.names,
					skill: input.skill,
					fork: input.fork,
					agentType: input.agentType,
				})

				// A fork appends no leading system message: its projection folds the forked-from agent's
				// history, leading blocks included, keeping the fork's prompt prefix byte-identical for
				// provider-cache reuse (D21).
				if (input.mode === 'fresh') {
					yield* appendLeadingSystemMessage(input)
				}

				if (entry._tag === 'agent_started') return entry

				// Invariant!
				return yield* Effect.die(new Error(`EventLog returned ${entry._tag} while appending agent_started`))
			}),
		)

		const switchModel: AgentRuntimeService['switchModel'] = Effect.fn('tart.agent_runtime.switch_model')(
			(input: SwitchModelInput) =>
				Effect.gen(function* () {
					// Epoch-transition choreography (D17): a model switch opens a new epoch, so the leading
					// system prompt and toolset re-resolve for the new family and all three facts land durably.
					// The next run's projection binds them; the caller swaps the LanguageModel layer (D15).
					const previousLevel = runtimeForAgent(yield* collectEntries, input.agentId).reasoningLevel

					yield* appendToEventLog({
						_tag: 'model-change',
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						toolCallId: input.toolCallId,
						model: input.model,
						reason: input.reason,
					})

					yield* appendLeadingSystemMessage(input)

					const resolvedToolset = yield* toolsetResolver.resolve({ model: input.model })
					yield* appendToEventLog({
						_tag: 'tools-change',
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						toolCallId: input.toolCallId,
						tools: resolvedToolset.names,
						reason: input.reason,
					})

					// Reasoning is part of the switched configuration: when the incoming model's requested
					// level differs from the projected level, the change lands as its own durable fact. The
					// model-change fold already rebinds the level (D23 - not an epoch boundary), so this entry
					// is written for log legibility and skipped when nothing changed.
					if (previousLevel !== input.model.requestedReasoningLevel) {
						yield* appendToEventLog({
							_tag: 'thinking-change',
							agentId: input.agentId,
							parentAgentId: input.parentAgentId,
							toolCallId: input.toolCallId,
							reasoningLevel: input.model.requestedReasoningLevel,
							reason: input.reason,
						})
					}
				}),
		)

		const run: AgentRuntimeService['run'] = Effect.fn('tart.agent_runtime.run')((input: RunAgentInput) =>
			Effect.gen(function* () {
				const stopRef = yield* Ref.make<string | null>(null)
				const stopController: StopControllerService = {
					requestStop: (reason) => Ref.set(stopRef, reason),
					isStopRequested: Ref.get(stopRef).pipe(Effect.map((reason) => reason !== null)),
				}
				// One reactive compact-and-retry per run (D11's guard, pi's single-attempt precedent).
				const overflowRecoveryRef = yield* Ref.make(false)
				const doomLoopRef = yield* Ref.make(initialDoomLoopState)

				for (const text of input.messages) {
					yield* appendUserMessage(input, text)
				}

				while (true) {
					const turn = yield* runTurn(input, stopController, stopRef, overflowRecoveryRef, doomLoopRef)
					if (turn._tag === 'finished') return turn.entry
				}
			}),
		)

		const compact: AgentRuntimeService['compact'] = Effect.fn('tart.agent_runtime.compact')(
			(input: CompactAgentInput) =>
				Effect.gen(function* () {
					const entries = yield* collectEntries
					const runtimeState = runtimeForAgent(entries, input.agentId)

					return yield* performCompaction(input, entries, runtimeState.activeModel, input.trigger)
				}),
		)

		return { start, run, switchModel, compact }
	}),
)
