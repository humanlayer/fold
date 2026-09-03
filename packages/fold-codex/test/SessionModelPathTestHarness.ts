import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import * as NodeServices from '@effect/platform-node/NodeServices'
import { readTool } from '@humanlayer/fold-agent'
import {
	AgentId,
	buildPrompt,
	CurrentAgent,
	CurrentToolCall,
	EventLog,
	foldPartOptionsKey,
	InterruptNote,
	layerInMemoryEventLog,
	LogEntryInputs,
	MessageId,
	messagesForAgent,
	providerToolCallIdKey,
	StopController,
	Subagents,
	ToolCallId,
	ToolEvents,
	ToolState,
	type FoldTool,
	type ToolHandlerServices,
	type ToolResultLogEntry,
} from '@humanlayer/fold-core'
import { Effect, Layer, Predicate, Schema, type Scope, Stream } from 'effect'
import { type LanguageModel, type Prompt, Toolkit } from 'effect/unstable/ai'

export const imageIdentificationPrompt =
	'Inspect the image returned by read. Name its three vertical color bands from left to right. ' +
	'Answer only as left=<color>,middle=<color>,right=<color>.'

export const expectedImageIdentification = 'left=yellow,middle=magenta,right=cyan'

const imageWidth = 96
const imageHeight = 48
const fixtureAgentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')

export type CapturedFetchRequest = {
	readonly url: string
	readonly authorization: string | null
	readonly body: string
}

const isWebRequest = (input: string | URL | Request): input is Request => Predicate.hasProperty(input, 'url')

/** Replace only Fetch while recording the fully encoded outbound HTTP request. */
export const makeCapturingFetch = (requests: Array<CapturedFetchRequest>, respond: () => Response): typeof fetch =>
	Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const request = isWebRequest(input) ? input : new Request(String(input), init)
			requests.push({
				url: request.url,
				authorization: request.headers.get('authorization'),
				body: await request.clone().text(),
			})
			return respond()
		},
		{ preconnect: fetch.preconnect },
	)

/** A real scoped temp directory for production filesystem and process-backed tool handlers. */
export const makeTemporaryTestDirectory = (prefix: string) =>
	Effect.acquireRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
		(directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
	)

const pngCrc32 = (bytes: Uint8Array): number => {
	let crc = 0xffffffff
	for (const byte of bytes) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
		}
	}
	return (crc ^ 0xffffffff) >>> 0
}

const pngChunk = (type: string, data: Uint8Array): Buffer => {
	const typeBytes = Buffer.from(type, 'ascii')
	const chunk = Buffer.alloc(12 + data.byteLength)
	chunk.writeUInt32BE(data.byteLength, 0)
	typeBytes.copy(chunk, 4)
	Buffer.from(data).copy(chunk, 8)
	chunk.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength)
	return chunk
}

/** Generate a tiny lossless PNG with three unambiguous, metadata-free color bands. */
export const makeDeterministicColorBandsPng = (): Uint8Array => {
	const header = Buffer.alloc(13)
	header.writeUInt32BE(imageWidth, 0)
	header.writeUInt32BE(imageHeight, 4)
	header[8] = 8 // bit depth
	header[9] = 6 // RGBA

	const scanlines = Buffer.alloc(imageHeight * (1 + imageWidth * 4))
	for (let y = 0; y < imageHeight; y += 1) {
		const rowOffset = y * (1 + imageWidth * 4)
		scanlines[rowOffset] = 0 // no PNG row filter
		for (let x = 0; x < imageWidth; x += 1) {
			const pixelOffset = rowOffset + 1 + x * 4
			const color: readonly [number, number, number] =
				x < imageWidth / 3 ? [255, 255, 0] : x < (imageWidth * 2) / 3 ? [255, 0, 255] : [0, 255, 255]
			scanlines[pixelOffset] = color[0]
			scanlines[pixelOffset + 1] = color[1]
			scanlines[pixelOffset + 2] = color[2]
			scanlines[pixelOffset + 3] = 255
		}
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(scanlines)),
		pngChunk('IEND', new Uint8Array()),
	])
}

const toolHandlerTestLayer: Layer.Layer<ToolHandlerServices> = Layer.mergeAll(
	NodeServices.layer,
	Layer.succeed(ToolState, { get: () => Effect.succeed(null), set: () => Effect.void }),
	Layer.succeed(ToolEvents, { emit: () => Effect.void }),
	Layer.succeed(StopController, { requestStop: () => Effect.void, isStopRequested: Effect.succeed(false) }),
	Layer.succeed(CurrentAgent, {
		agentId: fixtureAgentId,
		parentAgentId: null,
	}),
	Layer.succeed(CurrentToolCall, { toolCallId: ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa') }),
	Layer.succeed(InterruptNote, { set: () => Effect.void }),
	Layer.succeed(Subagents, {
		dispatch: () => Effect.die(new Error('Subagents are unavailable in the image-read test harness')),
		fork: () => Effect.die(new Error('Subagents are unavailable in the image-read test harness')),
		resume: () => Effect.die(new Error('Subagents are unavailable in the image-read test harness')),
		continueSubagent: () => Effect.die(new Error('Subagents are unavailable in the image-read test harness')),
	}),
)

const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

const toolCallIdAt = (index: number): ToolCallId =>
	ToolCallId.make(`tool_call_${String.fromCharCode('a'.charCodeAt(0) + index).repeat(24)}`)

const messageIdAt = (index: number): MessageId =>
	MessageId.make(`msg_${String.fromCharCode('a'.charCodeAt(0) + index).repeat(24)}`)

export type DurableToolResultInput = {
	readonly name: string
	readonly params: typeof Schema.Json.Type
	readonly result: typeof Schema.Json.Type
	readonly isFailure: boolean
	readonly providerToolCallId?: string
}

export type SessionPromptFixture = {
	readonly prompt: Prompt.Prompt
	readonly entries: ReadonlyArray<ToolResultLogEntry>
}

/** Execute one production Fold tool handler under the same platform and per-call services as runtime. */
export const executeToolHandler = (tool: FoldTool, params: unknown): Effect.Effect<unknown, unknown> =>
	tool.init.pipe(
		Effect.flatMap((contribution) => contribution.handler(params)),
		Effect.provide(toolHandlerTestLayer),
	)

/** Decode a real handler result/failure into the JSON shape accepted by the durable EventLog. */
export const decodeToolResultJson = (result: unknown) => decodeJson(result)

/** Persist real tool results, project the EventLog, and build the exact prompt used by session turns. */
export const buildSessionPromptWithToolResults = (input: {
	readonly userText: string
	readonly toolResults: ReadonlyArray<DurableToolResultInput>
}): Effect.Effect<SessionPromptFixture> =>
	Effect.gen(function* () {
		const eventLog = yield* EventLog
		yield* eventLog
			.append(
				LogEntryInputs['user-message']({
					agentId: fixtureAgentId,
					parentAgentId: null,
					toolCallId: null,
					messageId: messageIdAt(0),
					message: {
						role: 'user',
						content: [{ type: 'text', text: input.userText }],
					},
				}),
			)
			.pipe(Effect.orDie)
		yield* eventLog
			.append(
				LogEntryInputs['assistant-message']({
					agentId: fixtureAgentId,
					parentAgentId: null,
					toolCallId: null,
					messageId: messageIdAt(1),
					finish: null,
					message: {
						role: 'assistant',
						content: input.toolResults.map((toolResult, index) => ({
							type: 'tool-call' as const,
							id: toolCallIdAt(index),
							name: toolResult.name,
							params: toolResult.params,
							providerExecuted: false,
							options: {
								[foldPartOptionsKey]: {
									[providerToolCallIdKey]: toolResult.providerToolCallId ?? `call_test_${index + 1}`,
								},
							},
						})),
					},
				}),
			)
			.pipe(Effect.orDie)

		for (const [index, toolResult] of input.toolResults.entries()) {
			yield* eventLog
				.append(
					LogEntryInputs['tool-result']({
						agentId: fixtureAgentId,
						parentAgentId: null,
						toolCallId: toolCallIdAt(index),
						messageId: messageIdAt(index + 2),
						message: {
							role: 'tool',
							content: [
								{
									type: 'tool-result',
									id: toolCallIdAt(index),
									name: toolResult.name,
									result: toolResult.result,
									isFailure: toolResult.isFailure,
								},
							],
						},
					}),
				)
				.pipe(Effect.orDie)
		}

		const allEntries = yield* Stream.runCollect(eventLog.entries()).pipe(Effect.orDie)
		const entries = allEntries.filter((entry): entry is ToolResultLogEntry =>
			Predicate.isTagged(entry, 'tool-result'),
		)
		const prompt = yield* buildPrompt(messagesForAgent(allEntries, fixtureAgentId)).pipe(Effect.orDie)
		return { prompt, entries }
	}).pipe(Effect.provide(layerInMemoryEventLog))

export type ImageReadPromptFixture = {
	readonly prompt: Prompt.Prompt
	readonly readResult: typeof Schema.Json.Type
	readonly sourceImageBase64: string
}

/** Execute the production read tool, then feed its durable result through the session prompt builder. */
export const makeImageReadPromptFixture: Effect.Effect<ImageReadPromptFixture, unknown, Scope.Scope> =
	makeTemporaryTestDirectory('fold-image-read-delivery-').pipe(
		Effect.flatMap((directory) =>
			Effect.gen(function* () {
				const sourceImage = makeDeterministicColorBandsPng()
				yield* Effect.sync(() => writeFileSync(join(directory, 'visual-fixture.png'), sourceImage))

				const result = yield* executeToolHandler(readTool({ cwd: directory }), { path: 'visual-fixture.png' })
				const readResult = yield* decodeJson(result)
				const { prompt } = yield* buildSessionPromptWithToolResults({
					userText: imageIdentificationPrompt,
					toolResults: [
						{
							name: 'read',
							params: { path: 'visual-fixture.png' },
							result: readResult,
							isFailure: false,
							providerToolCallId: 'call_image_read_delivery',
						},
					],
				})

				return {
					prompt,
					readResult,
					sourceImageBase64: Buffer.from(sourceImage).toString('base64'),
				}
			}),
		),
	)

/**
 * Run the exact model-call shape used by AgentRuntime: session-built prompt, streaming, an explicitly
 * empty active toolkit, and tool-call resolution disabled for runtime-owned settlement.
 */
export const runImageReadInference = (model: LanguageModel.Service) =>
	Effect.gen(function* () {
		const fixture = yield* makeImageReadPromptFixture
		const emptyToolkit = yield* Toolkit.empty
		const parts = yield* Stream.runCollect(
			model.streamText({
				prompt: fixture.prompt,
				toolkit: emptyToolkit,
				disableToolCallResolution: true,
			}),
		)

		let text = ''
		for (const part of parts) {
			if (part.type === 'text-delta') text += part.delta
		}

		return { ...fixture, text }
	})
