import { decodeBashOutputDelta } from '@humanlayer/tart-agent'
import {
	defaultContextWindowFor,
	lookupCatalogEntry,
	shortAgentId,
	usageCacheRead,
	usageCacheWrite,
	usageInputTotal,
	usageInputUncached,
	usageOutputTotal,
	type ActiveModel,
	type AgentFinishedLogEntry,
	type AgentId,
	type LogEntry,
	type ModelCatalogEntry,
	type ModelPricing,
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
	/** Model catalog entries (D15) backing the usage table's Cost and Context columns. */
	readonly catalog?: ReadonlyArray<ModelCatalogEntry>
}

/** Machine-readable JSONL output modes. */
export type JsonOutputMode = 'json-concise' | 'json-verbose'

/** Creation options for the machine-readable JSONL renderer. */
export type JsonRendererOptions = {
	readonly stdout?: Writer
	readonly stderr?: Writer
	readonly mode?: JsonOutputMode
}

/** One CLI flag to carry into the printed resume command. */
export type ResumeCommandFlag = { readonly name: string; readonly value?: string }

/** Header values printed when a CLI session is opened. */
export type SessionHeader = {
	readonly sessionId: SessionId
	readonly cwd: string
	readonly logPath: string
	readonly mode: 'new' | 'resumed'
	/** Selected agent mode name; set only when the session runs a non-default mode. */
	readonly agentMode?: string
	/** Named config profile selected with --profile; absent when running the default roles. */
	readonly profile?: string
	/** Session-affecting flags from this CLI invocation, excluding --resume itself. */
	readonly resumeFlags?: ReadonlyArray<ResumeCommandFlag>
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

const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`

/** Create a JSONL renderer for programmatic/headless consumers. */
export const makeJsonOutputRenderer = (options?: JsonRendererOptions): OutputRenderer => {
	const stdout = options?.stdout ?? defaultStdout
	const stderr = options?.stderr ?? defaultStderr
	const mode = options?.mode ?? 'json-concise'
	const seenLogSeqs = new Set<number>()

	const writeEvent = (event: TartEvent): Effect.Effect<void> => stdout(jsonLine(event))

	return {
		renderHeader: () => Effect.void,
		renderEvent: (event) => {
			if (event.kind === 'log') {
				if (seenLogSeqs.has(event.entry.seq)) return Effect.void
				seenLogSeqs.add(event.entry.seq)
			}
			if (mode === 'json-concise' && event.kind !== 'log') return Effect.void
			return writeEvent(event)
		},
		renderFinish: (entry) => {
			if (seenLogSeqs.has(entry.seq)) return Effect.void
			seenLogSeqs.add(entry.seq)
			return writeEvent({ kind: 'log', entry })
		},
		renderResumeCommand: Effect.void,
		renderNote: (message) => stderr(`${message}\n`),
		renderError: (message) => stderr(`error: ${message}\n`),
		prompt: Effect.succeed(''),
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

const formatMaybeInt = (value: number | undefined): string => (value === undefined ? '--' : formatInt(value))

/**
 * Cost in USD of one response's reported usage at the given per-million-token rates, or null when
 * pricing is unknown (the table renders `--`). Providers fold cache reads/writes into
 * `inputTokens.total` (D11), so the freshly-billed input component is total minus both cache parts,
 * clamped at zero; unreported cache fields count as zero. Cache tokens reported without a matching
 * cache rate bill at the plain input rate - closer to the truth than billing them as free.
 */
export const responseCostUsd = (usage: UsageEncoded, pricing: ModelPricing | null): number | null => {
	if (pricing === null) return null

	const cacheReadTokens = usageCacheRead(usage) ?? 0
	const cacheWriteTokens = usageCacheWrite(usage) ?? 0
	const totalInputTokens = usageInputTotal(usage)
	const uncachedTokens = Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens)
	const outputTokens = usageOutputTotal(usage)

	const cacheReadRate = pricing.cacheReadPerMTokens ?? pricing.inputPerMTokens
	const cacheWriteRate = pricing.cacheWritePerMTokens ?? pricing.inputPerMTokens

	return (
		(uncachedTokens * pricing.inputPerMTokens +
			cacheReadTokens * cacheReadRate +
			cacheWriteTokens * cacheWriteRate +
			outputTokens * pricing.outputPerMTokens) /
		1_000_000
	)
}

const costText = (usage: UsageEncoded, entry: ModelCatalogEntry | null): string => {
	const cost = responseCostUsd(usage, entry?.pricing ?? null)
	return cost === null ? '--' : `$${cost.toFixed(4)}`
}

const contextText = (usage: UsageEncoded, model: ActiveModel | null, entry: ModelCatalogEntry | null): string => {
	const used = usageInputTotal(usage) + usageOutputTotal(usage)
	if (model === null) return formatInt(used)

	const limit = entry?.contextWindow ?? defaultContextWindowFor(model.modelId)
	const percent = Math.round((used / limit) * 100)
	return `${formatInt(used)}/${formatInt(limit)} (${percent}%)`
}

const usageTable = (
	ansi: AnsiPalette,
	usage: UsageEncoded,
	model: ActiveModel | null,
	catalog: ReadonlyArray<ModelCatalogEntry>,
): string => {
	const entry = model === null ? null : lookupCatalogEntry(catalog, model)
	const displayModel = shortModelId(model?.modelId ?? 'unknown')
	const modelWidth = Math.max(5, displayModel.length) + 2
	const header =
		`  ${'Model'.padEnd(modelWidth)} ${'Input'.padStart(8)} ${'CacheR'.padStart(8)} ` +
		`${'CacheW'.padStart(8)} ${'Output'.padStart(8)} ${'Cost'.padStart(8)} ${'Context'.padStart(20)}`
	const row =
		`  ${displayModel.padEnd(modelWidth)} ${formatInt(usageInputUncached(usage)).padStart(8)} ` +
		`${formatMaybeInt(usageCacheRead(usage)).padStart(8)} ${formatMaybeInt(usageCacheWrite(usage)).padStart(8)} ` +
		`${formatInt(usageOutputTotal(usage)).padStart(8)} ${costText(usage, entry).padStart(8)} ` +
		`${contextText(usage, model, entry).padStart(20)}`

	return `${ansi.dim(header)}\n${row}`
}

const formattedFlag = (flag: ResumeCommandFlag): string =>
	flag.value === undefined ? `--${flag.name}` : `--${flag.name} ${shellQuote(flag.value)}`

const resumeCommand = (
	sessionId: SessionId,
	input: { readonly model: ActiveModel | null; readonly flags: ReadonlyArray<ResumeCommandFlag> },
): string => {
	const flags = [`--resume ${shellQuote(sessionId)}`]
	if (input.flags.length > 0) {
		flags.push(...input.flags.map(formattedFlag))
	} else if (input.model !== null) {
		const model = input.model
		flags.push(`--provider ${shellQuote(model.providerId)}`)
		flags.push(`--model ${shellQuote(model.modelId)}`)
		if (model.role !== null && model.role !== 'inherit') flags.push(`--role ${shellQuote(model.role)}`)
		if (model.requestedReasoningLevel !== 'off')
			flags.push(`--reasoning ${shellQuote(model.requestedReasoningLevel)}`)
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
	const catalog = options?.catalog ?? []
	const agentsWithText = new Set<string>()
	const assistantLabelOpen = new Set<string>()
	const streamedAssistantText = new Set<string>()
	const hiddenToolOutputNotices = new Set<string>()
	const agentModels = new Map<string, ActiveModel>()
	const latestUsage = new Map<string, { readonly usage: UsageEncoded; readonly model: ActiveModel | null }>()
	// Subagent attribution: every non-root agent gets a `<type>·<4-char id>` label from its agent_started
	// row and a stable palette color by registration order; root output stays untagged.
	const agentLabels = new Map<string, string>()
	const agentTagColors = new Map<string, (text: string) => string>()
	let currentSessionId: SessionId | null = null
	let headerModel: ActiveModel | null = null
	let headerResumeFlags: ReadonlyArray<ResumeCommandFlag> = []
	let rootAgentId: string | null = null
	let lineOpen = false
	// The agent whose streamed deltas last wrote to stdout, for interleaving transition markers.
	let lastStreamAgentId: string | null = null

	// Distinct, stable subagent tag colors; green/red stay reserved for assistant/error accents.
	const tagPalette: ReadonlyArray<(text: string) => string> = [ansi.magenta, ansi.cyan, ansi.yellow]

	// 4 id characters are plenty to tell one session's agents apart; refs down to 4 chars resolve (AgentIdRef).
	const shortIdSuffix = (agentId: AgentId): string =>
		shortAgentId(agentId).slice('agent_'.length, 'agent_'.length + 4)

	/** The compact `agent_xxxx` display form used on subagent start/done lines (a valid /steer//send target). */
	const displayAgentId = (agentId: AgentId): string => `agent_${shortIdSuffix(agentId)}`

	const registerAgentLabel = (entry: Extract<LogEntry, { readonly _tag: 'agent_started' }>): void => {
		if (entry.parentAgentId === null || agentLabels.has(entry.agentId)) return
		const kind = entry.agentType ?? (entry.mode === 'fork' ? 'fork' : 'agent')
		const color = tagPalette[agentLabels.size % tagPalette.length] ?? ansi.magenta
		agentLabels.set(entry.agentId, `${kind}·${shortIdSuffix(entry.agentId)}`)
		agentTagColors.set(entry.agentId, color)
	}

	/** The plain `[label]` text of a non-root agent, or null for the root/unknown agents. */
	const plainTagFor = (agentId: string): string | null => {
		const label = agentLabels.get(agentId)
		return label === undefined ? null : `[${label}]`
	}

	/** The colored bracket tag prefixed to every rendered line of a non-root agent. */
	const tagFor = (agentId: string): string | null => {
		const plain = plainTagFor(agentId)
		if (plain === null) return null
		const color = agentTagColors.get(agentId) ?? ansi.magenta
		return color(plain)
	}

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

	/** Render one line attributed to an agent: non-root agents get their bracket tag prefix. */
	const renderAgentLine = (agentId: string, text: string): Effect.Effect<void> =>
		Effect.suspend(() => {
			const tag = tagFor(agentId)
			return renderLine(tag === null ? text : `${tag} ${text}`)
		})

	/**
	 * Write one streamed delta chunk for a tagged (non-root) agent: the tag opens every flushed line -
	 * at a line start and after each newline inside the chunk - so interleaved streams stay attributed.
	 * Each line segment runs through `decorate` (identity for text, dim for reasoning, ...).
	 */
	const writeTaggedDelta = (tag: string, delta: string, decorate: (text: string) => string): Effect.Effect<void> =>
		Effect.suspend(() => {
			if (delta.length === 0) return Effect.void
			const leading = lineOpen ? '' : `${tag} `
			const endsWithNewline = delta.endsWith('\n')
			const body = (endsWithNewline ? delta.slice(0, -1) : delta)
				.split('\n')
				.map((segment) => (segment.length === 0 ? segment : decorate(segment)))
				.join(`\n${tag} `)
			return writeStdout(`${leading}${body}${endsWithNewline ? '\n' : ''}`)
		})

	const renderToolCalls = (entry: Extract<LogEntry, { readonly _tag: 'assistant-message' }>) =>
		Effect.forEach(
			contentParts(entry.message.content).filter((part) => part.type === 'tool-call'),
			(part) =>
				renderAgentLine(
					entry.agentId,
					`${label(ansi, 'tool')} ${ansi.cyan(part.name ?? 'tool')} ${truncate(safeStringify(part.params), verbose ? 2000 : 300)}`,
				),
			{ discard: true },
		)

	const renderToolResult = (entry: Extract<LogEntry, { readonly _tag: 'tool-result' }>) => {
		const failed = contentParts(entry.message.content).some(
			(part) => part.type === 'tool-result' && part.isFailure === true,
		)
		const color = failed ? ansi.red : ansi.green
		return renderAgentLine(entry.agentId, `${label(ansi, 'tool')} ${color('result')} ${ansi.dim(entry.toolCallId)}`)
	}

	const renderAssistantText = (agentId: string, text: string): Effect.Effect<void> =>
		text.length === 0 ? Effect.void : renderAgentLine(agentId, `${ansi.green('[assistant]')} ${text}`)

	const renderLog = (entry: LogEntry): Effect.Effect<void> => {
		switch (entry._tag) {
			case 'session_started':
			case 'system-message':
			case 'tool_state':
			case 'session_title':
				return Effect.void

			case 'agent_started':
				agentModels.set(entry.agentId, entry.model)
				if (entry.parentAgentId === null) rootAgentId = entry.agentId
				registerAgentLabel(entry)
				// The id is the /steer//send target, so it is printed on every start line; subagents show
				// the short form because that is exactly what those commands accept.
				return entry.parentAgentId === null
					? renderLine(`${label(ansi, 'agent')} ${entry.agentId} ${modelName(entry)}`)
					: renderAgentLine(
							entry.agentId,
							`${label(ansi, 'subagent')} ${displayAgentId(entry.agentId)} ${modelName(entry)}`,
						)

			case 'user-message': {
				const text = textContent(entry.message.content)
				return text.length === 0 ? Effect.void : renderAgentLine(entry.agentId, `${ansi.cyan('>')} ${text}`)
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
				return renderAgentLine(
					entry.agentId,
					`${label(ansi, 'compact')} summarized through seq ${entry.replacesThroughSeq} (${entry.tokensBefore} tokens)`,
				)

			case 'model-change':
				agentModels.set(entry.agentId, entry.model)
				return renderAgentLine(entry.agentId, `${label(ansi, 'model')} ${modelName(entry)}`)

			case 'thinking-change':
				return renderAgentLine(entry.agentId, `${label(ansi, 'thinking')} ${entry.reasoningLevel}`)

			case 'tools-change':
				return renderAgentLine(entry.agentId, `${label(ansi, 'tools')} ${entry.tools.join(', ')}`)

			case 'agent-finished':
				return entry.parentAgentId === null ? Effect.void : renderFinish(entry)

			case 'error':
				return renderAgentLine(
					entry.agentId ?? '',
					`${label(ansi, 'error')} ${ansi.red(entry.errorType)} ${entry.message}`,
				)
		}
	}

	/**
	 * Handle a stream-source change before writing a delta: close any open line and, when the incoming
	 * agent is a tagged subagent, print a one-line dim transition marker so interleaved streams stay
	 * legible; a switch back to the root re-opens its `[assistant]` label instead. Returns the effect to
	 * run before the delta itself. Root-only sessions never change source, so their output is untouched.
	 */
	const streamTransition = (agentId: string, tag: string | null): Effect.Effect<void> => {
		if (lastStreamAgentId === agentId) return Effect.void
		const previous = lastStreamAgentId
		lastStreamAgentId = agentId
		if (previous === null) return Effect.void

		if (tag === null) {
			assistantLabelOpen.delete(agentId)
			return newlineIfOpen()
		}
		return renderLine(ansi.dim(`--- ${plainTagFor(agentId) ?? `[${agentId}]`} ---`))
	}

	const renderEvent = (event: TartEvent): Effect.Effect<void> => {
		if (event.kind === 'log') return renderLog(event.entry)

		switch (event.part.type) {
			case 'text-delta': {
				const agentId = event.agentId
				const delta = event.part.delta
				return Effect.suspend(() => {
					const tag = tagFor(agentId)
					const transition = streamTransition(agentId, tag)
					agentsWithText.add(agentId)
					streamedAssistantText.add(agentId)
					const prefix = assistantLabelOpen.has(agentId)
						? Effect.void
						: Effect.suspend(() =>
								newlineIfOpen().pipe(
									Effect.andThen(
										writeStdout(`${tag === null ? '' : `${tag} `}${ansi.green('[assistant]')} `),
									),
								),
							)
					assistantLabelOpen.add(agentId)
					const body = tag === null ? writeStdout(delta) : writeTaggedDelta(tag, delta, (segment) => segment)
					return transition.pipe(Effect.andThen(prefix), Effect.andThen(body))
				})
			}

			case 'reasoning-delta': {
				const agentId = event.agentId
				const delta = event.part.delta
				return Effect.suspend(() => {
					const tag = tagFor(agentId)
					if (tag === null)
						return streamTransition(agentId, null).pipe(Effect.andThen(writeStdout(ansi.dim(delta))))
					return streamTransition(agentId, tag).pipe(Effect.andThen(writeTaggedDelta(tag, delta, ansi.dim)))
				})
			}

			case 'tool-progress': {
				const toolName = event.part.toolName
				const payload = event.part.payload
				const bash = decodeBashOutputDelta(payload)
				if (bash !== null) {
					if (verbose)
						return Effect.suspend(() => {
							const tag = tagFor(event.agentId)
							const decorate = bash.stream === 'stderr' ? ansi.yellow : ansi.dim
							return tag === null
								? writeStdout(decorate(bash.text))
								: writeTaggedDelta(tag, bash.text, decorate)
						})

					const noticeKey = `${event.toolCallId ?? 'unknown'}:${toolName}`
					if (hiddenToolOutputNotices.has(noticeKey)) return Effect.void
					hiddenToolOutputNotices.add(noticeKey)
					return renderAgentLine(
						event.agentId,
						`${label(ansi, 'tool')} ${ansi.cyan(toolName)} output hidden; pass --verbose to stream it`,
					)
				}

				return renderAgentLine(
					event.agentId,
					`${label(ansi, 'tool')} ${ansi.cyan(toolName)} ${truncate(safeStringify(payload), verbose ? 2000 : 300)}`,
				)
			}
		}
	}

	const renderFinish = (entry: AgentFinishedLogEntry): Effect.Effect<void> => {
		const printedText = agentsWithText.has(entry.agentId)
		const color = outcomeColor(ansi, entry.outcome)
		const tag = tagFor(entry.agentId)
		const result =
			entry.resultText === null || printedText
				? Effect.void
				: tag === null
					? renderLine(entry.resultText)
					: renderAgentLine(entry.agentId, entry.resultText)
		const usage = latestUsage.get(entry.agentId)
		const resumeModel = usage?.model ?? agentModels.get(entry.agentId) ?? headerModel
		agentsWithText.delete(entry.agentId)
		streamedAssistantText.delete(entry.agentId)
		assistantLabelOpen.delete(entry.agentId)

		return result.pipe(
			Effect.andThen(newlineIfOpen()),
			Effect.andThen(
				writeStdout(
					`${tag === null ? '' : `${tag} `}${label(ansi, 'done')} ${color(entry.outcome)} session=${currentSessionId ?? 'unknown'} agent=${
						tag === null ? entry.agentId : displayAgentId(entry.agentId)
					} outcome=${entry.outcome}${entry.reason === null ? '' : ` reason=${entry.reason}`}\n\n`,
				),
			),
			Effect.andThen(
				currentSessionId === null
					? Effect.void
					: writeStdout(
							`${ansi.dim('resume')} ${resumeCommand(currentSessionId, {
								model: resumeModel,
								flags: headerResumeFlags,
							})}\n\n`,
						),
			),
			Effect.andThen(
				usage === undefined
					? Effect.void
					: writeStdout(`${usageTable(ansi, usage.usage, usage.model, catalog)}\n\n`),
			),
		)
	}

	return {
		renderHeader: (header) =>
			Effect.sync(() => {
				currentSessionId = header.sessionId
				headerModel = header.model
				headerResumeFlags = header.resumeFlags ?? []
			}).pipe(
				Effect.andThen(
					writeStdout(
						`${ansi.bold('tart')} ${header.mode === 'new' ? ansi.green('new session') : ansi.cyan('resumed session')} ${header.sessionId}\n` +
							(header.agentMode === undefined ? '' : `${ansi.dim('mode')} ${header.agentMode}\n`) +
							(header.profile === undefined ? '' : `${ansi.dim('profile')} ${header.profile}\n`) +
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
							writeStdout(
								`\n${ansi.dim('resume')} ${resumeCommand(currentSessionId, {
									model: currentResumeModel(),
									flags: headerResumeFlags,
								})}\n\n`,
							),
						),
					),
		),
		renderNote: (message) => writeStdout(`${ansi.dim(message)}\n`),
		renderError: (message) => writeStderr(`${ansi.red('error:')} ${message}\n`),
		prompt: Effect.succeed(`${ansi.green('tart')} ${ansi.dim('>')} `),
	}
}
