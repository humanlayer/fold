/**
 * Shared engine-test harness for the Subagents slice: a real facade session whose root model calls a
 * test-only `drive` tool once per send, and whose handler yields the ambient Subagents service with an
 * instruction chosen at runtime - so resume ids (only known after a dispatch) can be fed back in while
 * the facade, provisioning, per-call ambient services, and child loops all stay real. Also provides a
 * hang-once scripted model for interrupt scenarios: its first request signals a Deferred and never
 * produces output; later requests (the resume) serve scripted turns.
 */
import { Deferred, Effect, Ref, Schema, Stream } from 'effect'
import { AiError, LanguageModel } from 'effect/unstable/ai'

import {
	customModel,
	defineAgent,
	defineTool,
	renderSubagentResult,
	startSession,
	Subagents,
	subagentTool,
	type ActiveModel,
	type AgentId,
	type AgentStartedLogEntry,
	type LogEntry,
	type SessionProfiles,
	type SubagentDefinition,
	type FoldModel,
} from '../../src/index'
import { gptActiveModel, scriptedModel } from '../Api/ApiTestHelpers'
import { textTurn, toolCallTurn, type ScriptedTurn } from '../TestLayers/ScriptedLanguageModel'

/** One engine operation the drive tool should perform on its next invocation. */
export type DriveInstruction =
	| { readonly op: 'dispatch'; readonly agent: string; readonly prompt: string; readonly skill?: string }
	| { readonly op: 'resume'; readonly agentId: AgentId; readonly prompt: string }
	| { readonly op: 'fork'; readonly prompt: string }

/** A test-only tool whose handler drives the ambient Subagents engine from a mutable instruction slot. */
export const makeDriveTool = (instructions: Ref.Ref<ReadonlyArray<DriveInstruction>>, roster: ReadonlyArray<string>) =>
	defineTool({
		name: 'drive',
		description: 'Test driver over the Subagents engine.',
		parameters: Schema.Struct({}),
		success: Schema.Struct({ content: Schema.String }),
		failure: Schema.Struct({ message: Schema.String }),
		handler: () =>
			Effect.gen(function* () {
				const remaining = yield* Ref.get(instructions)
				const instruction = remaining[0]
				if (instruction === undefined) {
					return yield* Effect.die(new Error('drive tool invoked with no instruction queued'))
				}
				yield* Ref.set(instructions, remaining.slice(1))

				const subagents = yield* Subagents
				const failWith = (error: { readonly _tag: string }) => ({
					message: `${instruction.op} failed: ${error._tag}`,
				})

				if (instruction.op === 'dispatch') {
					const result = yield* subagents
						.dispatch({
							agent: instruction.agent,
							prompt: instruction.prompt,
							skill: instruction.skill ?? null,
							allowedAgents: roster,
						})
						.pipe(Effect.mapError(failWith))
					return { content: renderSubagentResult(result) }
				}

				if (instruction.op === 'resume') {
					const result = yield* subagents
						.resume({ agentId: instruction.agentId, prompt: instruction.prompt, skill: null })
						.pipe(Effect.mapError(failWith))
					return { content: renderSubagentResult(result) }
				}

				const result = yield* subagents
					.fork({ prompt: instruction.prompt, skill: null })
					.pipe(Effect.mapError(failWith))
				return { content: renderSubagentResult(result) }
			}),
	})

/** A session whose root calls `drive` once per send, with instructions swappable between sends. */
export const makeDriveSession = (input: {
	readonly definitions: ReadonlyArray<SubagentDefinition>
	/** Paired [drive tool call, text] turns; or pass `rootScript` for full control. */
	readonly rootTurns: number
	readonly rootScript?: ReadonlyArray<ScriptedTurn>
	/** Initial role->model bindings, for rosters with role-bound definitions (profiles slice). */
	readonly profiles?: SessionProfiles
}) =>
	Effect.gen(function* () {
		const instructions = yield* Ref.make<ReadonlyArray<DriveInstruction>>([])
		const roster = input.definitions.map((definition) => definition.name)

		const rootScripted = yield* scriptedModel(
			gptActiveModel,
			input.rootScript ??
				Array.from({ length: input.rootTurns }, (_, index) => [
					toolCallTurn([{ id: `provider-call-${index}`, name: 'drive', params: {} }]),
					textTurn(`root-done-${index}`),
				]).flat(),
		)

		const session = yield* startSession({
			agent: defineAgent({
				model: rootScripted.model,
				systemPrompt: 'root',
				tools: [makeDriveTool(instructions, roster), subagentTool(input.definitions)],
			}),
			...(input.profiles === undefined ? {} : { profiles: input.profiles }),
		})

		/** Queue one instruction; the caller decides how to run the send (await, fork, ...). */
		const queue = (instruction: DriveInstruction) => Ref.set(instructions, [instruction])

		/** Queue one instruction and run a full send to completion. */
		const drive = (instruction: DriveInstruction) =>
			queue(instruction).pipe(Effect.flatMap(() => session.send('next')))

		return { session, drive, queue, rootScripted }
	})

/** The agent_started rows of dispatched subagents (parented rows), in log order. */
export const subagentStartedEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<AgentStartedLogEntry> =>
	entries.filter(
		(entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started' && entry.parentAgentId !== null,
	)

/** The nth durable tool-result's rendered content, JSON-stringified for substring assertions. */
export const renderedDriveResult = (entries: ReadonlyArray<LogEntry>, occurrence: number): string => {
	const results = entries.filter((entry) => entry._tag === 'tool-result')
	const entry = results[occurrence]
	if (entry === undefined || entry._tag !== 'tool-result') throw new Error('expected a tool-result entry')
	return JSON.stringify(entry.message.content[0])
}

/** Handle to a hang-once model: first request hangs forever (after signaling); later requests script. */
export type HangOnceModel = {
	readonly model: FoldModel
	/** Succeeds when the hanging (first) request reaches the model. */
	readonly firstRequestStarted: Deferred.Deferred<void>
	/** Every prompt sent to the model (the hanging first request included), in request order. */
	readonly prompts: Effect.Effect<ReadonlyArray<unknown>>
}

/**
 * A model whose FIRST streamText call signals `firstRequestStarted` and then never emits - the
 * interruption target - while every later call (the resume) serves the given scripted turns. The
 * hang-once flag lives outside the provider `make`, so per-dispatch re-provisioning cannot reset it.
 */
export const makeHangOnceModel = (
	activeModel: ActiveModel,
	resumeTurns: ReadonlyArray<ScriptedTurn>,
): Effect.Effect<HangOnceModel> =>
	Effect.gen(function* () {
		const firstRequestStarted = yield* Deferred.make<void>()
		const hungOnce = yield* Ref.make(false)
		const turnsRef = yield* Ref.make<ReadonlyArray<ScriptedTurn>>(resumeTurns)
		const promptsRef = yield* Ref.make<ReadonlyArray<unknown>>([])

		const make = LanguageModel.make({
			generateText: () => Effect.die(new Error('hang-once model supports streamText only')),
			streamText: (options) =>
				Stream.unwrap(
					Effect.gen(function* () {
						yield* Ref.update(promptsRef, (prompts) => [...prompts, options.prompt])

						const alreadyHung = yield* Ref.getAndSet(hungOnce, true)
						if (!alreadyHung) {
							yield* Deferred.succeed(firstRequestStarted, undefined)
							return Stream.fromEffect(Effect.never)
						}

						const remaining = yield* Ref.get(turnsRef)
						const turn = remaining[0]
						if (turn === undefined) {
							return yield* Effect.die(new Error('hang-once model: resume script exhausted'))
						}
						yield* Ref.set(turnsRef, remaining.slice(1))

						return turn._tag === 'failure'
							? Stream.fail(
									AiError.make({
										module: 'HangOnceModel',
										method: 'streamText',
										reason: new AiError.UnknownError({ description: turn.message }),
									}),
								)
							: Stream.fromIterable(turn.parts)
					}),
				),
		})

		return { model: customModel({ activeModel, make }), firstRequestStarted, prompts: Ref.get(promptsRef) }
	})
