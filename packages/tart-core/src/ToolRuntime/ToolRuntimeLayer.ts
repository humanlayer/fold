/**
 * This file defines the live ToolRuntime layer consumed by AgentRuntime after an assistant message has
 * been persisted. The layer consumes EventLog, Ids, HookRunner, Toolset, and ToolEventSink; it produces
 * per-call ToolState, ToolEvents, and StopController services while handlers run, then persists one durable
 * tool-result entry per call, including synthetic interruption results when a tool fiber is interrupted.
 */
import { Effect, Exit, Layer, Ref, Schema, Stream, SynchronizedRef } from 'effect'
import { Prompt } from 'effect/unstable/ai'

import { EventLog } from '../EventLog/EventLogService'
import type { ToolResultLogEntry } from '../EventLog/Schemas'
import { HookRunner } from '../HookRunner/HookRunnerService'
import { Ids, ToolCallId, type AgentId } from '../Ids'
import { StopController, ToolEventSink, ToolEvents } from './ToolContextServices'
import { ToolRuntime, type ToolRuntimeService, type ToolSettlement } from './ToolRuntimeService'
import { Toolset, type ToolHandlerOutput } from './ToolsetService'
import { toolStateServiceForToolCall } from './ToolStateFactory'
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

const interruptedToolResult =
	'<system-information>The user interrupted the execution of this tool call.</system-information>'

/** Return true when an assistant message part is a model-requested tool call. */
const isToolCallPart = (part: Prompt.AssistantMessage['content'][number]): part is ToolCallPart =>
	part.type === 'tool-call'

/** Extract the tool-call parts from a persisted assistant message in model order. */
const toolCallsFromAssistantMessage = (assistantMessage: Prompt.AssistantMessage): ReadonlyArray<ToolCallPart> =>
	assistantMessage.content.filter(isToolCallPart)

/** Decode and validate the provider-supplied tool call id as a Tart ToolCallId. */
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

/** Run a tool-result append effect at most once and return the first written entry thereafter. */
const appendToolResultAtMostOnce = <R>(
	written: SynchronizedRef.SynchronizedRef<ToolResultLogEntry | null>,
	append: Effect.Effect<ToolResultLogEntry, never, R>,
): Effect.Effect<ToolResultLogEntry, never, R> =>
	SynchronizedRef.modifyEffect(written, (current) => {
		if (current !== null) return Effect.succeed([current, current] as const)

		return append.pipe(Effect.map((entry) => [entry, entry] as const))
	})

/** Compare unknown values by stable JSON representation, falling back to object identity when needed. */
const valuesHaveSameJsonRepresentation = (left: unknown, right: unknown): boolean => {
	try {
		return JSON.stringify(left) === JSON.stringify(right)
	} catch {
		return Object.is(left, right)
	}
}

/** Convert any thrown or failed value into a short user-visible failure message. */
const failureMessageFromUnknown = (value: unknown): string => {
	if (value instanceof Error) return value.message

	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

/** Build the final handler output used when a tool handler fails while streaming. */
const failedToolHandlerOutput = (toolName: string, cause: unknown): ToolHandlerOutput => ({
	result: {
		message: `Tool "${toolName}" failed: ${failureMessageFromUnknown(cause)}`,
	},
	encodedResult: {
		message: `Tool "${toolName}" failed: ${failureMessageFromUnknown(cause)}`,
	},
	isFailure: true,
	preliminary: false,
})

/** Apply pre-tool hooks and return either an executable call or a replacement result. */
const toolCallPreparedByPreToolHooks = (input: {
	readonly agentId: AgentId
	readonly toolCall: ToolCallPart
}): Effect.Effect<PreparedToolCall, never, HookRunner> =>
	Effect.gen(function* () {
		const hooks = yield* HookRunner
		const toolCallId = yield* decodeToolCallId(input.toolCall)

		const decision = yield* hooks.preToolUse({
			agentId: input.agentId,
			toolCallId,
			toolName: input.toolCall.name,
			params: input.toolCall.params,
		})

		switch (decision._tag) {
			case 'replaceResult':
				return {
					_tag: 'replaceResult',
					original: input.toolCall,
					result: decision.result,
					isFailure: decision.isFailure,
				}

			case 'continue':
				return {
					_tag: 'execute',
					original: input.toolCall,
					params: decision.params,
				}
		}
	})

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
}): Effect.Effect<FinalToolOutput, never, Toolset | ToolEventSink> =>
	Effect.gen(function* () {
		const toolset = yield* Toolset
		const stream = yield* toolset.handle(input.toolName, input.params).pipe(
			Effect.matchEffect({
				onFailure: (cause) => Effect.succeed(Stream.succeed(failedToolHandlerOutput(input.toolName, cause))),
				onSuccess: Effect.succeed,
			}),
		)

		const outputs = yield* stream.pipe(
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
			Effect.matchEffect({
				onFailure: (cause) => Effect.succeed([failedToolHandlerOutput(input.toolName, cause)]),
				onSuccess: (outputs) => Effect.succeed(outputs),
			}),
		)

		return finalToolOutputFromHandlerOutputs(outputs, input.toolName)
	})

/** Apply post-tool hooks to a successful final output, leaving failures untouched. */
const finalOutputAfterPostToolHooks = (input: {
	readonly agentId: AgentId
	readonly toolCallId: ToolCallId
	readonly toolName: string
	readonly output: FinalToolOutput
}): Effect.Effect<FinalToolOutput, never, HookRunner> =>
	Effect.gen(function* () {
		if (input.output.isFailure) return input.output

		const hooks = yield* HookRunner
		const decision = yield* hooks.postToolUse({
			agentId: input.agentId,
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
}): Effect.Effect<ToolResultLogEntry, never, EventLog | Ids | HookRunner | Toolset | ToolEventSink> =>
	Effect.gen(function* () {
		const toolCallId = yield* decodeToolCallId(input.prepared.original)
		const toolName = input.prepared.original.name
		const written = yield* SynchronizedRef.make<ToolResultLogEntry | null>(null)
		const sink = yield* ToolEventSink

		const toolState = yield* toolStateServiceForToolCall({
			agentId: input.agentId,
			parentAgentId: input.parentAgentId,
			toolCallId,
			namespace: toolName,
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

		const appendInterruptedToolResult = appendToolResultToEventLog({
			agentId: input.agentId,
			parentAgentId: input.parentAgentId,
			toolCallId,
			toolName,
			result: interruptedToolResult,
			isFailure: true,
		})

		const run = Effect.gen(function* () {
			if (input.prepared._tag === 'replaceResult') {
				return yield* appendToolResultAtMostOnce(
					written,
					appendToolResultToEventLog({
						agentId: input.agentId,
						parentAgentId: input.parentAgentId,
						toolCallId,
						toolName,
						result: input.prepared.result,
						isFailure: input.prepared.isFailure,
					}),
				)
			}

			const output = yield* finalOutputFromToolHandler({
				agentId: input.agentId,
				parentAgentId: input.parentAgentId,
				toolCallId,
				toolName,
				params: input.prepared.params,
			})

			const finalOutput = yield* finalOutputAfterPostToolHooks({
				agentId: input.agentId,
				toolCallId,
				toolName,
				output,
			})

			return yield* appendToolResultAtMostOnce(
				written,
				appendToolResultToEventLog({
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					toolCallId,
					toolName,
					result: finalOutput.result,
					isFailure: finalOutput.isFailure,
					...(valuesHaveSameJsonRepresentation(input.prepared.original.params, input.prepared.params)
						? {}
						: { executedInput: input.prepared.params }),
				}),
			)
		})

		return yield* run.pipe(
			Effect.provideService(ToolState, toolState),
			Effect.provideService(ToolEvents, toolEvents),
			Effect.provideService(StopController, stopController),
			Effect.onExit((exit) =>
				Exit.hasInterrupts(exit)
					? Effect.uninterruptible(
							appendToolResultAtMostOnce(written, appendInterruptedToolResult).pipe(Effect.asVoid),
						)
					: Effect.void,
			),
		)
	})

type SettleToolCallsInput = Parameters<ToolRuntimeService['settle']>[0]

/** Settle every tool call in one assistant message and report whether a stop was requested. */
const settleToolCalls = (
	input: SettleToolCallsInput,
): Effect.Effect<ToolSettlement, never, EventLog | Ids | HookRunner | Toolset | ToolEventSink> =>
	Effect.gen(function* () {
		const stopRef = yield* Ref.make<string | null>(null)
		const toolCalls = toolCallsFromAssistantMessage(input.assistantMessage)

		const prepared = yield* Effect.forEach(
			toolCalls,
			(toolCall) => toolCallPreparedByPreToolHooks({ agentId: input.agentId, toolCall }),
			{ concurrency: 1 },
		)

		const toolResults = yield* Effect.forEach(
			prepared,
			(preparedCall) =>
				settlePreparedToolCall({
					agentId: input.agentId,
					parentAgentId: input.parentAgentId,
					prepared: preparedCall,
					stopRef,
				}),
			{ concurrency: 'unbounded' },
		)

		const stopRequested = yield* Ref.get(stopRef).pipe(Effect.map((reason) => reason !== null))

		return {
			toolResults,
			stopRequested,
		}
	}).pipe(
		Effect.withSpan('tart.tool_runtime.settle', {
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
	EventLog | Ids | HookRunner | Toolset | ToolEventSink
> = Layer.effect(
	ToolRuntime,
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		const ids = yield* Ids
		const hooks = yield* HookRunner
		const toolset = yield* Toolset
		const sink = yield* ToolEventSink

		const settle: ToolRuntimeService['settle'] = Effect.fn('tart.tool_runtime.settle')((input) =>
			settleToolCalls(input).pipe(
				Effect.provideService(EventLog, eventLog),
				Effect.provideService(Ids, ids),
				Effect.provideService(HookRunner, hooks),
				Effect.provideService(Toolset, toolset),
				Effect.provideService(ToolEventSink, sink),
			),
		)

		return { settle }
	}),
)
