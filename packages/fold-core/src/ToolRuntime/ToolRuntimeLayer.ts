/**
 * This file defines the live ToolRuntime layer consumed by AgentRuntime after an assistant message has
 * been persisted. The layer consumes EventLog, Ids, HookRunner, Toolset, and ToolEventSink; it produces
 * per-call ToolState, ToolEvents, and StopController services while handlers run, then persists one durable
 * tool-result entry per call, including synthetic interruption results when a tool fiber is interrupted.
 */
import { Cause, Effect, Layer, Ref, Schema, Stream } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import { EventLog } from '../EventLog/EventLogService'
import type { LogEntry, ToolResultLogEntry } from '../EventLog/Schemas'
import { HookExecutionError } from '../HookRunner/Errors'
import { HookRunner } from '../HookRunner/HookRunnerService'
import { Ids, ToolCallId, type AgentId } from '../Ids'
import { Subagents } from '../Subagents/SubagentsService'
import { modelVisibleErrorDetailsFromCause, systemInformation } from './ModelVisibleErrors'
import {
	CurrentAgent,
	CurrentToolCall,
	InterruptNote,
	StopController,
	ToolEventSink,
	ToolEvents,
} from './ToolContextServices'
import { ToolRuntime, type ToolRuntimeService, type ToolSettlement } from './ToolRuntimeService'
import { Toolset, type ToolHandlerOutput } from './ToolsetService'
import { toolStateServiceForHandler } from './ToolStateFactory'
import { ToolState } from './ToolStateService'

type ToolCallPart = Prompt.ToolCallPart

type PreparedToolCall =
	| {
			readonly _tag: 'execute'
			readonly original: ToolCallPart
			readonly params: unknown
	  }
	| {
			readonly _tag: 'replaceResult'
			readonly original: ToolCallPart
			readonly result: unknown
			readonly isFailure: boolean
	  }

type FinalToolOutput = {
	readonly result: unknown
	readonly isFailure: boolean
}

type ToolResultAppendInput = {
	readonly result: unknown
	readonly isFailure: boolean
	readonly executedInput?: unknown
}

const interruptedToolResult =
	'<system-information>The user interrupted the execution of this tool call.</system-information>'

/**
 * Compose the synthetic result for an interrupted tool call. When the handler recorded an
 * {@link InterruptNote} before the interruption (the subagent tool's resume guidance, bash's
 * partial-output path), the note rides inside the same system-information block so the model can act
 * on it after a session resume.
 */
const interruptedToolResultWithNote = (note: string | null): string =>
	note === null
		? interruptedToolResult
		: `<system-information>The user interrupted the execution of this tool call.\n${note}</system-information>`

/** Return true when an assistant message part is a model-requested tool call. */
const isToolCallPart = (part: Prompt.AssistantMessage['content'][number]): part is ToolCallPart =>
	part.type === 'tool-call'

/** Extract the tool-call parts from a persisted assistant message in model order. */
const toolCallsFromAssistantMessage = (assistantMessage: Prompt.AssistantMessage): ReadonlyArray<ToolCallPart> =>
	assistantMessage.content.filter(isToolCallPart)

/** Decode and validate the provider-supplied tool call id as a Fold ToolCallId. */
const decodeToolCallId = (toolCall: ToolCallPart): Effect.Effect<ToolCallId> =>
	Schema.decodeUnknownEffect(ToolCallId)(toolCall.id).pipe(Effect.orDie)

/** Encode one persisted tool-result message in Effect AI's Prompt schema. */
const encodedToolResultMessage = (input: {
	readonly toolCallId: ToolCallId
	readonly toolName: string
	readonly result: unknown
	readonly isFailure: boolean
}) =>
	Effect.sync(() =>
		Schema.encodeUnknownSync(Prompt.ToolMessage)(
			Prompt.toolMessage({
				content: [
					Prompt.toolResultPart({
						id: input.toolCallId,
						name: input.toolName,
						result: input.result,
						isFailure: input.isFailure,
					}),
				],
			}),
		),
	)

/** Build an appender that writes tool-result entries through EventLog with fresh message ids. */
const appendToolResultToEventLog = (input: {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId
	readonly toolName: string
	readonly result: unknown
	readonly isFailure: boolean
	readonly executedInput?: unknown
}): Effect.Effect<ToolResultLogEntry, never, EventLog | Ids> =>
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids
		const message = yield* encodedToolResultMessage(input)

		const entry = yield* eventLog
			.append({
				_tag: 'tool-result',
				agentId: input.agentId,
				parentAgentId: input.parentAgentId,
				toolCallId: input.toolCallId,
				messageId: yield* ids.makeMessageId,
				message,
				...(input.executedInput === undefined ? {} : { executedInput: input.executedInput }),
			})
			.pipe(Effect.orDie)

		if (entry._tag === 'tool-result') return entry

		// Invariant!
		return yield* Effect.die(new Error(`EventLog returned ${entry._tag} while appending tool-result`))
	})

/** Compare unknown values by stable JSON representation, falling back to object identity when needed. */
const valuesHaveSameJsonRepresentation = (left: unknown, right: unknown): boolean => {
	try {
		return JSON.stringify(left) === JSON.stringify(right)
	} catch {
		return Object.is(left, right)
	}
}

const unexpectedToolFailureResult = (toolName: string, cause: Cause.Cause<unknown>): string =>
	systemInformation(`Tool "${toolName}" failed unexpectedly: ${modelVisibleErrorDetailsFromCause(cause)}`)

const hookFailureResult = (error: HookExecutionError, toolName: string): string => {
	const phase = error.phase === 'preToolUse' ? 'preToolUse' : 'postToolUse'
	const action = error.phase === 'preToolUse' ? 'preparing' : 'finalizing'

	return systemInformation(
		`${phase} hook "${error.hookName}" failed unexpectedly while ${action} tool "${toolName}": ${modelVisibleErrorDetailsFromCause(error.cause)}`,
	)
}

const hookExecutionErrorFromCause = (cause: Cause.Cause<unknown>): HookExecutionError | undefined => {
	const reason = cause.reasons.find(Cause.isFailReason)

	return reason?.error instanceof HookExecutionError ? reason.error : undefined
}

const failureResultFromCause = (toolName: string, cause: Cause.Cause<unknown>): string => {
	const hookError = hookExecutionErrorFromCause(cause)

	return hookError === undefined
		? unexpectedToolFailureResult(toolName, cause)
		: hookFailureResult(hookError, toolName)
}

/** Build the final handler output used when a tool handler fails while streaming. */
const failedToolHandlerOutput = (toolName: string, cause: Cause.Cause<unknown>): ToolHandlerOutput => ({
	result: unexpectedToolFailureResult(toolName, cause),
	encodedResult: unexpectedToolFailureResult(toolName, cause),
	isFailure: true,
	preliminary: false,
})

/** Build the handler output for a failed or interrupted handler stream, reading the interrupt note. */
const failedOrInterruptedToolHandlerOutput = (
	toolName: string,
	cause: Cause.Cause<unknown>,
	interruptNoteRef: Ref.Ref<string | null>,
): Effect.Effect<ToolHandlerOutput> =>
	Cause.hasInterrupts(cause)
		? Ref.get(interruptNoteRef).pipe(
				Effect.map((note): ToolHandlerOutput => {
					const text = interruptedToolResultWithNote(note)
					return { result: text, encodedResult: text, isFailure: true, preliminary: false }
				}),
			)
		: Effect.succeed(failedToolHandlerOutput(toolName, cause))

/** Apply pre-tool hooks and return either an executable call or a replacement result. */
const toolCallPreparedByPreToolHooks = (input: {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCall: ToolCallPart
}): Effect.Effect<PreparedToolCall, never, HookRunner | StopController> =>
	Effect.gen(function* () {
		const hooks = yield* HookRunner
		const toolCallId = yield* decodeToolCallId(input.toolCall)

		const decision = yield* hooks.preToolUse({
			agentId: input.agentId,
			parentAgentId: input.parentAgentId,
			toolCallId,
			toolName: input.toolCall.name,
			params: input.toolCall.params,
		})

		switch (decision._tag) {
			case 'replaceResult':
				return {
					_tag: 'replaceResult' as const,
					original: input.toolCall,
					result: decision.result,
					isFailure: decision.isFailure,
				}

			case 'continue':
				return {
					_tag: 'execute' as const,
					original: input.toolCall,
					params: decision.params,
				}
		}
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.succeed({
				_tag: 'replaceResult' as const,
				original: input.toolCall,
				result: Cause.hasInterrupts(cause)
					? interruptedToolResult
					: failureResultFromCause(input.toolCall.name, cause),
				isFailure: true,
			}),
		),
	)

/** Select the final non-preliminary handler output, or synthesize a failure when none exists. */
const finalToolOutputFromHandlerOutputs = (
	outputs: ReadonlyArray<ToolHandlerOutput>,
	toolName: string,
): FinalToolOutput => {
	const final = outputs.findLast((output) => !output.preliminary)

	if (final !== undefined) {
		return {
			result: final.encodedResult,
			isFailure: final.isFailure,
		}
	}

	return {
		result: {
			message: `Tool "${toolName}" completed without a final result.`,
		},
		isFailure: true,
	}
}

/** Forward one preliminary handler output to the session ToolEventSink as JSON progress. */
const emitPreliminaryToolOutput = (input: {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId
	readonly toolName: string
	readonly output: ToolHandlerOutput
}): Effect.Effect<void, never, ToolEventSink> => {
	if (!input.output.preliminary) return Effect.void

	return Effect.gen(function* () {
		const sink = yield* ToolEventSink
		const payload = yield* Effect.sync(() => Schema.decodeUnknownSync(Schema.Json)(input.output.encodedResult))

		yield* sink.emit({
			agentId: input.agentId,
			parentAgentId: input.parentAgentId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			payload,
		})
	})
}

/** Execute one prepared tool handler and reduce its output stream to a final persisted output. */
const finalOutputFromToolHandler = (input: {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId
	readonly toolName: string
	readonly params: unknown
	readonly interruptNoteRef: Ref.Ref<string | null>
}): Effect.Effect<
	FinalToolOutput,
	never,
	| Toolset
	| ToolEventSink
	| ToolState
	| ToolEvents
	| StopController
	| CurrentAgent
	| CurrentToolCall
	| InterruptNote
	| Subagents
> =>
	Effect.gen(function* () {
		const toolset = yield* Toolset
		const stream = yield* toolset
			.handle(input.toolName, input.params)
			.pipe(
				Effect.catchCause((cause) =>
					failedOrInterruptedToolHandlerOutput(input.toolName, cause, input.interruptNoteRef).pipe(
						Effect.map(Stream.succeed),
					),
				),
			)

		const collectHandlerOutputs = stream.pipe(
			Stream.tap((output) =>
				emitPreliminaryToolOutput({
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCallId: input.toolCallId,
					toolName: input.toolName,
					output,
				}),
			),
			Stream.runCollect,
		)

		const outputs = yield* collectHandlerOutputs.pipe(
			Effect.catchCause((cause) =>
				failedOrInterruptedToolHandlerOutput(input.toolName, cause, input.interruptNoteRef).pipe(
					Effect.map((output): ReadonlyArray<ToolHandlerOutput> => [output]),
				),
			),
		)

		return finalToolOutputFromHandlerOutputs(outputs, input.toolName)
	})

/** Apply post-tool hooks to a successful final output, leaving failures untouched. */
const finalOutputAfterPostToolHooks = (input: {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId
	readonly toolName: string
	readonly output: FinalToolOutput
}): Effect.Effect<FinalToolOutput, HookExecutionError, HookRunner | StopController> =>
	Effect.gen(function* () {
		if (input.output.isFailure) return input.output

		const hooks = yield* HookRunner
		const decision = yield* hooks.postToolUse({
			agentId: input.agentId,
			parentAgentId: input.parentAgentId,
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			result: input.output.result,
			isFailure: input.output.isFailure,
		})

		switch (decision._tag) {
			case 'keep':
				return input.output

			case 'replace':
				return {
					result: decision.result,
					isFailure: decision.isFailure,
				}
		}
	})

/** Execute or replace one prepared tool call and persist exactly one tool-result entry. */
const settlePreparedToolCall = (input: {
	readonly agentId: AgentId
	readonly parentAgentId: AgentId | null
	readonly prepared: PreparedToolCall
	readonly stopRef: Ref.Ref<string | null>
	readonly stateSnapshot: ReadonlyArray<LogEntry>
}): Effect.Effect<ToolResultLogEntry, never, EventLog | Ids | HookRunner | Toolset | ToolEventSink | Subagents> =>
	Effect.gen(function* () {
		const toolCallId = yield* decodeToolCallId(input.prepared.original)
		const toolName = input.prepared.original.name
		const sink = yield* ToolEventSink

		const toolState = yield* toolStateServiceForHandler({
			agentId: input.agentId,
			parentAgentId: input.parentAgentId,
			toolCallId,
			snapshot: input.stateSnapshot,
		})

		const toolEvents = {
			/** Annotate and forward one JSON progress payload from the running handler. */
			emit: (payload: typeof Schema.Json.Type) =>
				sink.emit({
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCallId,
					toolName,
					payload,
				}),
		}

		const stopController = {
			/** Record a cooperative stop request shared by all concurrently running tool calls. */
			requestStop: (reason: string) => Ref.set(input.stopRef, reason),
			/** Report whether any tool or hook has requested a cooperative stop. */
			isStopRequested: Ref.get(input.stopRef).pipe(Effect.map((reason) => reason !== null)),
		}

		// The per-call interrupt note: handlers set it as soon as resumable/externally-visible work
		// exists, and finalizers may refine it during unwind; interrupt synthesis below reads it last.
		const interruptNoteRef = yield* Ref.make<string | null>(null)
		const interruptNote = {
			/** Record the note appended inside this call's synthetic result if it is interrupted. */
			set: (note: string) => Ref.set(interruptNoteRef, note),
		}

		const output: Effect.Effect<
			ToolResultAppendInput,
			HookExecutionError,
			| HookRunner
			| StopController
			| Toolset
			| ToolEventSink
			| ToolState
			| ToolEvents
			| CurrentAgent
			| CurrentToolCall
			| InterruptNote
			| Subagents
		> = Effect.gen(function* () {
			if (input.prepared._tag === 'replaceResult') {
				return {
					result: input.prepared.result,
					isFailure: input.prepared.isFailure,
				}
			}

			const handlerOutput = yield* finalOutputFromToolHandler({
				agentId: input.agentId,
				parentAgentId: input.parentAgentId,
				toolCallId,
				toolName,
				params: input.prepared.params,
				interruptNoteRef,
			})

			const finalOutput = yield* finalOutputAfterPostToolHooks({
				agentId: input.agentId,
				parentAgentId: input.parentAgentId,
				toolCallId,
				toolName,
				output: handlerOutput,
			})

			return {
				result: finalOutput.result,
				isFailure: finalOutput.isFailure,
				...(valuesHaveSameJsonRepresentation(input.prepared.original.params, input.prepared.params)
					? {}
					: { executedInput: input.prepared.params }),
			}
		})

		const append = (result: ToolResultAppendInput) =>
			appendToolResultToEventLog({
				agentId: input.agentId,
				parentAgentId: input.parentAgentId,
				toolCallId,
				toolName,
				result: result.result,
				isFailure: result.isFailure,
				...(result.executedInput === undefined ? {} : { executedInput: result.executedInput }),
			})

		const runnable = output.pipe(
			Effect.provideService(ToolState, toolState),
			Effect.provideService(ToolEvents, toolEvents),
			Effect.provideService(StopController, stopController),
			Effect.provideService(CurrentAgent, { agentId: input.agentId, parentAgentId: input.parentAgentId }),
			Effect.provideService(CurrentToolCall, { toolCallId }),
			Effect.provideService(InterruptNote, interruptNote),
		)

		return yield* Effect.uninterruptibleMask((restore) =>
			restore(runnable).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterrupts(cause)
						? // Handler finalizers already ran during unwind, so the note carries their final
							// word (the subagent tool's agent_id + turn count, bash's spill-file path).
							Ref.get(interruptNoteRef).pipe(
								Effect.map((note) => ({
									result: interruptedToolResultWithNote(note),
									isFailure: true,
								})),
							)
						: Effect.succeed({
								result: failureResultFromCause(toolName, cause),
								isFailure: true,
							}),
				),
				Effect.flatMap(append),
			),
		)
	})

type SettleToolCallsInput = Parameters<ToolRuntimeService['settle']>[0]

/** Settle every tool call in one assistant message and report whether a stop was requested. */
const settleToolCalls = (
	input: SettleToolCallsInput,
): Effect.Effect<ToolSettlement, never, EventLog | Ids | HookRunner | Toolset | ToolEventSink | Subagents> =>
	Effect.gen(function* () {
		const stopRef = yield* Ref.make<string | null>(null)
		const stopController = {
			requestStop: (reason: string) => Ref.set(stopRef, reason),
			isStopRequested: Ref.get(stopRef).pipe(Effect.map((reason) => reason !== null)),
		}
		const toolCalls = toolCallsFromAssistantMessage(input.assistantMessage)

		const prepared = yield* Effect.forEach(
			toolCalls,
			(toolCall) =>
				toolCallPreparedByPreToolHooks({
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCall,
				}).pipe(Effect.provideService(StopController, stopController)),
			{ concurrency: 1 },
		)

		// Snapshot state once at the fork point, after all preToolUse chains and before any handler runs,
		// so parallel handlers read a stable view instead of each other's mid-batch writes.
		const eventLog = yield* EventLog
		const stateSnapshot = yield* Stream.runCollect(eventLog.entries()).pipe(
			Effect.orDie,
			Effect.map((entries): ReadonlyArray<LogEntry> => entries),
		)

		const toolResults = yield* Effect.forEach(
			prepared,
			(preparedCall) =>
				settlePreparedToolCall({
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					prepared: preparedCall,
					stopRef,
					stateSnapshot,
				}),
			{ concurrency: 'unbounded' },
		)

		const stopRequested = yield* Ref.get(stopRef).pipe(Effect.map((reason) => reason !== null))

		return {
			toolResults,
			stopRequested,
		}
	}).pipe(
		Effect.withSpan('fold.tool_runtime.settle', {
			attributes: {
				agentId: input.agentId,
				parentAgentId: input.parentAgentId ?? 'none',
			},
		}),
	)

/** Live ToolRuntime layer that wires EventLog, Ids, hooks, tools, and progress sinks into settlement. */
export const liveToolRuntimeLayer: Layer.Layer<
	ToolRuntime,
	never,
	EventLog | Ids | HookRunner | Toolset | ToolEventSink | Subagents
> = Layer.effect(
	ToolRuntime,
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids
		const hooks = yield* HookRunner
		const toolset = yield* Toolset
		const sink = yield* ToolEventSink
		const subagents = yield* Subagents

		const settle: ToolRuntimeService['settle'] = Effect.fn('fold.tool_runtime.settle')((input) =>
			settleToolCalls(input).pipe(
				Effect.provideService(EventLog, eventLog),
				Effect.provideService(Ids, ids),
				Effect.provideService(HookRunner, hooks),
				Effect.provideService(Toolset, toolset),
				Effect.provideService(ToolEventSink, sink),
				Effect.provideService(Subagents, subagents),
			),
		)

		return { settle }
	}),
)
