import { decodeBashOutputDelta } from '@humanlayer/tart-agent'
import {
	defaultContextWindowFor,
	type ActiveModel,
	type AgentFinishedLogEntry,
	type LogEntry,
	type SessionId,
	type UsageEncoded,
} from '@humanlayer/tart-core'
import type { TartEvent } from '@humanlayer/tart-core'
import { Effect } from 'effect'

import { makeAnsiPalette, type AnsiPalette } from './Ansi'

type Writer = (text: string) => Effect.Effect<void>

type EncodedPart = {
	readonly type: string
	readonly text?: string
	readonly name?: string
	readonly params?: unknown
	readonly result?: unknown
	readonly isFailure?: boolean
}

/** Creation options for the colored headless output renderer. */
export type RendererOptions = {
	readonly stdout?: Writer
	readonly stderr?: Writer
	readonly colors?: boolean
	/** Stream full tool output/progress instead of compact notices. */
	readonly verbose?: boolean
}

/** Header values printed when a CLI session is opened. */
export type SessionHeader = {
	readonly sessionId: SessionId
	readonly cwd: string
	readonly logPath: string
	readonly mode: 'new' | 'resumed'
	readonly model: ActiveModel | null
	readonly credential: CredentialSummary
}

/** Human-safe credential status printed in the session header. */
export type CredentialSummary =
	| { readonly _tag: 'found'; readonly detail: string }
	| { readonly _tag: 'missing'; readonly detail: string }
	| { readonly _tag: 'unknown'; readonly detail: string }

/** Mutable renderer state hidden behind a small event-rendering surface. */
export type OutputRenderer = {
	readonly renderHeader: (header: SessionHeader) => Effect.Effect<void>
	readonly renderEvent: (event: TartEvent) => Effect.Effect<void>
	readonly renderFinish: (entry: AgentFinishedLogEntry) => Effect.Effect<void>
	readonly renderResumeCommand: Effect.Effect<void>
	readonly renderNote: (message: string) => Effect.Effect<void>
	readonly renderError: (message: string) => Effect.Effect<void>
	readonly prompt: Effect.Effect<string>
}

const defaultStdout: Writer = (text) => Effect.sync(() => process.stdout.write(text))
const defaultStderr: Writer = (text) => Effect.sync(() => process.stderr.write(text))

const safeStringify = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return String(value)
	}
}

const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max)}... (${text.length - max} more chars)`

const contentParts = (content: unknown): ReadonlyArray<EncodedPart> => {
	if (typeof content === 'string') return [{ type: 'text', text: content }]
	if (!Array.isArray(content)) return []

	return content.filter(
		(part): part is EncodedPart => typeof part === 'object' && part !== null && typeof part.type === 'string',
	)
}

const textContent = (content: unknown): string =>
	contentParts(content)
		.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : []))
		.join('')

const label = (ansi: AnsiPalette, text: string): string => ansi.dim(`[${text}]`)

const modelName = (entry: Extract<LogEntry, { readonly _tag: 'agent_started' | 'model-change' }>): string => {
	const role = entry.model.role === null ? '' : ` role=${entry.model.role}`
	return `${entry.model.providerId}/${entry.model.modelId}${role}`
}

const activeModelName = (model: ActiveModel): string => {
	const role = model.role === null ? '' : ` role=${model.role}`
	return `${model.providerId}/${model.modelId} (${model.providerKind}${role})`
}

const credentialText = (ansi: AnsiPalette, credential: CredentialSummary): string => {
	switch (credential._tag) {
		case 'found':
			return `${ansi.green('found')} ${credential.detail}`
		case 'missing':
			return `${ansi.red('not found')} ${credential.detail}`
		case 'unknown':
			return `${ansi.yellow('unknown')} ${credential.detail}`
	}
}

const shortModelId = (modelId: string): string => modelId.split('/').at(-1) ?? modelId

const formatInt = (value: number): string => value.toLocaleString('en-US')

const shellQuote = (value: string): string => {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
	return `'${value.replaceAll("'", "'\\''")}'`
}

const inputUncached = (usage: UsageEncoded): number => usage.inputTokens.uncached ?? usage.inputTokens.total ?? 0
const inputTotal = (usage: UsageEncoded): number => usage.inputTokens.total ?? inputUncached(usage)
const cacheRead = (usage: UsageEncoded): number | undefined => usage.inputTokens.cacheRead
const cacheWrite = (usage: UsageEncoded): number | undefined => usage.inputTokens.cacheWrite
const outputTotal = (usage: UsageEncoded): number => usage.outputTokens.total ?? 0

const formatMaybeInt = (value: number | undefined): string => (value === undefined ? '--' : formatInt(value))

const contextText = (usage: UsageEncoded, model: ActiveModel | null): string => {
	const used = inputTotal(usage) + outputTotal(usage)
	if (model === null) return formatInt(used)

	const limit = defaultContextWindowFor(model.modelId)
	const percent = Math.round((used / limit) * 100)
	return `${formatInt(used)}/${formatInt(limit)} (${percent}%)`
}

const usageTable = (ansi: AnsiPalette, usage: UsageEncoded, model: ActiveModel | null): string => {
	const displayModel = shortModelId(model?.modelId ?? 'unknown')
	const modelWidth = Math.max(5, displayModel.length) + 2
	const header =
		`  ${'Model'.padEnd(modelWidth)} ${'Input'.padStart(8)} ${'CacheR'.padStart(8)} ` +
		`${'CacheW'.padStart(8)} ${'Output'.padStart(8)} ${'Cost'.padStart(8)} ${'Context'.padStart(20)}`
	const row =
		`  ${displayModel.padEnd(modelWidth)} ${formatInt(inputUncached(usage)).padStart(8)} ` +
		`${formatMaybeInt(cacheRead(usage)).padStart(8)} ${formatMaybeInt(cacheWrite(usage)).padStart(8)} ` +
		`${formatInt(outputTotal(usage)).padStart(8)} ${'--'.padStart(8)} ${contextText(usage, model).padStart(20)}`

	return `${ansi.dim(header)}\n${row}`
}

const resumeCommand = (sessionId: SessionId, model: ActiveModel | null): string => {
	const flags = [`--resume ${shellQuote(sessionId)}`]
	if (model !== null) {
		flags.push(`--provider ${shellQuote(model.providerId)}`)
		flags.push(`--model ${shellQuote(model.modelId)}`)
		if (model.role !== null && model.role !== 'inherit') flags.push(`--role ${shellQuote(model.role)}`)
		if (model.requestedReasoningLevel !== 'off') flags.push(`--reasoning ${shellQuote(model.requestedReasoningLevel)}`)
	}

	return `tart ${flags.join(' ')}`
}

const outcomeColor = (ansi: AnsiPalette, outcome: AgentFinishedLogEntry['outcome']): ((text: string) => string) => {
	switch (outcome) {
		case 'completed':
			return ansi.green
		case 'stopped':
			return ansi.yellow
		case 'interrupted':
			return ansi.yellow
		case 'error':
			return ansi.red
	}
}

/** Create the CLI's colored renderer for durable log rows plus live deltas. */
export const makeOutputRenderer = (options?: RendererOptions): OutputRenderer => {
	const stdout = options?.stdout ?? defaultStdout
	const stderr = options?.stderr ?? defaultStderr
	const ansi = makeAnsiPalette(options?.colors ?? true)
	const verbose = options?.verbose ?? false
	const agentsWithText = new Set<string>()
	const assistantLabelOpen = new Set<string>()
	const streamedAssistantText = new Set<string>()
	const hiddenToolOutputNotices = new Set<string>()
	const agentModels = new Map<string, ActiveModel>()
	const latestUsage = new Map<string, { readonly usage: UsageEncoded; readonly model: ActiveModel | null }>()
	let currentSessionId: SessionId | null = null
	let headerModel: ActiveModel | null = null
	let rootAgentId: string | null = null
	let lineOpen = false

	const writeStdout = (text: string): Effect.Effect<void> =>
		stdout(text).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					if (text.length > 0) lineOpen = !text.endsWith('\n')
				}),
			),
		)

	const writeStderr = (text: string): Effect.Effect<void> => stderr(text)

	const newlineIfOpen = (): Effect.Effect<void> => (lineOpen ? writeStdout('\n') : Effect.void)
	const currentResumeModel = (): ActiveModel | null =>
		rootAgentId === null ? headerModel : (agentModels.get(rootAgentId) ?? headerModel)

	const renderLine = (text: string): Effect.Effect<void> =>
		newlineIfOpen().pipe(Effect.andThen(writeStdout(`${text}\n`)))

	const renderToolCalls = (entry: Extract<LogEntry, { readonly _tag: 'assistant-message' }>) =>
		Effect.forEach(
			contentParts(entry.message.content).filter((part) => part.type === 'tool-call'),
			(part) =>
				renderLine(
					`${label(ansi, 'tool')} ${ansi.cyan(part.name ?? 'tool')} ${truncate(safeStringify(part.params), verbose ? 2000 : 300)}`,
				),
			{ discard: true },
		)

	const renderToolResult = (entry: Extract<LogEntry, { readonly _tag: 'tool-result' }>) => {
		const failed = contentParts(entry.message.content).some(
			(part) => part.type === 'tool-result' && part.isFailure === true,
		)
		const color = failed ? ansi.red : ansi.green
		return renderLine(`${label(ansi, 'tool')} ${color('result')} ${ansi.dim(entry.toolCallId)}`)
	}

	const renderAssistantText = (agentId: string, text: string): Effect.Effect<void> =>
		text.length === 0 ? Effect.void : renderLine(`${ansi.green('[assistant]')} ${text}`)

	const renderLog = (entry: LogEntry): Effect.Effect<void> => {
		switch (entry._tag) {
			case 'session_started':
			case 'system-message':
			case 'tool_state':
				return Effect.void

			case 'agent_started':
				agentModels.set(entry.agentId, entry.model)
				if (entry.parentAgentId === null) rootAgentId = entry.agentId
				return renderLine(
					`${label(ansi, entry.parentAgentId === null ? 'agent' : 'subagent')} ${modelName(entry)}`,
				)

			case 'user-message': {
				const text = textContent(entry.message.content)
				return text.length === 0 ? Effect.void : renderLine(`${ansi.cyan('>')} ${text}`)
			}

			case 'assistant-message': {
				if (entry.finish !== null) {
					latestUsage.set(entry.agentId, {
						usage: entry.finish.usage,
						model: agentModels.get(entry.agentId) ?? headerModel,
					})
				}

				const text = textContent(entry.message.content)
				const textEffect = streamedAssistantText.has(entry.agentId)
					? Effect.void
					: renderAssistantText(entry.agentId, text)
				if (text.length > 0) agentsWithText.add(entry.agentId)
				streamedAssistantText.delete(entry.agentId)
				assistantLabelOpen.delete(entry.agentId)

				return textEffect.pipe(Effect.andThen(renderToolCalls(entry)))
			}

			case 'tool-result':
				return renderToolResult(entry)

			case 'compaction':
				return renderLine(
					`${label(ansi, 'compact')} summarized through seq ${entry.replacesThroughSeq} (${entry.tokensBefore} tokens)`,
				)

			case 'model-change':
				agentModels.set(entry.agentId, entry.model)
				return renderLine(`${label(ansi, 'model')} ${modelName(entry)}`)

			case 'thinking-change':
				return renderLine(`${label(ansi, 'thinking')} ${entry.reasoningLevel}`)

			case 'tools-change':
				return renderLine(`${label(ansi, 'tools')} ${entry.tools.join(', ')}`)

			case 'agent-finished':
				return entry.parentAgentId === null ? Effect.void : renderFinish(entry)

			case 'error':
				return renderLine(`${label(ansi, 'error')} ${ansi.red(entry.errorType)} ${entry.message}`)
		}
	}

	const renderEvent = (event: TartEvent): Effect.Effect<void> => {
		if (event.kind === 'log') return renderLog(event.entry)

		switch (event.part.type) {
			case 'text-delta': {
				agentsWithText.add(event.agentId)
				streamedAssistantText.add(event.agentId)
				const prefix = assistantLabelOpen.has(event.agentId)
					? Effect.void
					: newlineIfOpen().pipe(Effect.andThen(writeStdout(`${ansi.green('[assistant]')} `)))
				assistantLabelOpen.add(event.agentId)
				return prefix.pipe(Effect.andThen(writeStdout(event.part.delta)))
			}

			case 'reasoning-delta':
				return writeStdout(ansi.dim(event.part.delta))

			case 'tool-progress': {
				const bash = decodeBashOutputDelta(event.part.payload)
				if (bash !== null) {
					if (verbose)
						return writeStdout(bash.stream === 'stderr' ? ansi.yellow(bash.text) : ansi.dim(bash.text))

					const noticeKey = `${event.toolCallId ?? 'unknown'}:${event.part.toolName}`
					if (hiddenToolOutputNotices.has(noticeKey)) return Effect.void
					hiddenToolOutputNotices.add(noticeKey)
					return renderLine(
						`${label(ansi, 'tool')} ${ansi.cyan(event.part.toolName)} output hidden; pass --verbose to stream it`,
					)
				}

				return renderLine(
					`${label(ansi, 'tool')} ${ansi.cyan(event.part.toolName)} ${truncate(safeStringify(event.part.payload), verbose ? 2000 : 300)}`,
				)
			}
		}
	}

	const renderFinish = (entry: AgentFinishedLogEntry): Effect.Effect<void> => {
		const printedText = agentsWithText.has(entry.agentId)
		const color = outcomeColor(ansi, entry.outcome)
		const result = entry.resultText === null || printedText ? Effect.void : renderLine(entry.resultText)
		const usage = latestUsage.get(entry.agentId)
		const resumeModel = usage?.model ?? agentModels.get(entry.agentId) ?? headerModel
		agentsWithText.delete(entry.agentId)
		streamedAssistantText.delete(entry.agentId)
		assistantLabelOpen.delete(entry.agentId)

		return result.pipe(
			Effect.andThen(newlineIfOpen()),
			Effect.andThen(
				writeStdout(
					`${label(ansi, 'done')} ${color(entry.outcome)} session=${currentSessionId ?? 'unknown'} agent=${entry.agentId} outcome=${entry.outcome}${
						entry.reason === null ? '' : ` reason=${entry.reason}`
					}\n\n`,
				),
			),
			Effect.andThen(
				currentSessionId === null
					? Effect.void
					: writeStdout(`${ansi.dim('resume')} ${resumeCommand(currentSessionId, resumeModel)}\n\n`),
			),
			Effect.andThen(usage === undefined ? Effect.void : writeStdout(`${usageTable(ansi, usage.usage, usage.model)}\n\n`)),
		)
	}

	return {
		renderHeader: (header) =>
			Effect.sync(() => {
				currentSessionId = header.sessionId
				headerModel = header.model
			}).pipe(
				Effect.andThen(
					writeStdout(
						`${ansi.bold('tart')} ${header.mode === 'new' ? ansi.green('new session') : ansi.cyan('resumed session')} ${header.sessionId}\n` +
							`${ansi.dim('model')} ${header.model === null ? ansi.yellow('unknown') : activeModelName(header.model)}\n` +
							`${ansi.dim('credential')} ${credentialText(ansi, header.credential)}\n` +
							`${ansi.dim('cwd')} ${header.cwd}\n` +
							`${ansi.dim('log')} ${header.logPath}\n`,
					),
				),
			),
		renderEvent,
		renderFinish,
		renderResumeCommand: Effect.suspend(() =>
			currentSessionId === null
				? Effect.void
				: newlineIfOpen().pipe(
						Effect.andThen(
							writeStdout(`\n${ansi.dim('resume')} ${resumeCommand(currentSessionId, currentResumeModel())}\n\n`),
						),
					),
		),
		renderNote: (message) => writeStdout(`${ansi.dim(message)}\n`),
		renderError: (message) => writeStderr(`${ansi.red('error:')} ${message}\n`),
		prompt: Effect.succeed(`${ansi.green('tart')} ${ansi.dim('>')} `),
	}
}
