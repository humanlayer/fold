import type { AgentId, AgentStartedLogEntry, LogEntry } from '@humanlayer/fold-core'

export type SubagentStatus = 'running' | 'done' | 'error' | 'stopped' | 'interrupted'

export type SubagentView = {
	readonly agentId: AgentId
	readonly calledAt: number
	readonly type: string
	readonly description: string
	readonly prompt: string
	readonly status: SubagentStatus
	readonly turns: number
	readonly tools: number
	readonly entries: ReadonlyArray<LogEntry>
}

export type SkillView = {
	readonly name: string
	readonly description: string
	readonly loaded: boolean
	readonly used: boolean
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const field = (value: unknown, name: string): unknown =>
	typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined

const dispatchDetails = (entries: ReadonlyArray<LogEntry>, toolCallId: string | null) => {
	if (toolCallId === null) return undefined
	for (const entry of entries) {
		if (entry._tag !== 'assistant-message' || typeof entry.message.content === 'string') continue
		for (const part of entry.message.content) {
			if (part.type !== 'tool-call' || part.id !== toolCallId || part.name !== 'subagent') continue
			const prompt = text(field(part.params, 'prompt')) ?? ''
			return {
				description: text(field(part.params, 'description')) ?? prompt.replace(/\s+/g, ' ').trim().slice(0, 60),
				prompt,
			}
		}
	}
	return undefined
}

export const subagentViews = (entries: ReadonlyArray<LogEntry>, rootAgentId: AgentId): ReadonlyArray<SubagentView> => {
	const starts = entries.filter(
		(entry): entry is AgentStartedLogEntry => entry._tag === 'agent_started' && entry.agentId !== rootAgentId,
	)
	return starts
		.toSorted((left, right) => left.seq - right.seq)
		.map((start) => {
			const own = entries.filter((entry) => entry.agentId === start.agentId)
			const finish = own.filter((entry) => entry._tag === 'agent-finished').at(-1)
			const continuing = own.some(
				(entry) => entry._tag === 'user-message' && (finish === undefined || entry.seq > finish.seq),
			)
			const details = dispatchDetails(entries, start.toolCallId)
			return {
				agentId: start.agentId,
				calledAt: start.ts,
				type: start.agentType ?? (start.mode === 'fork' ? 'fork' : 'subagent'),
				description: details?.description || 'delegated task',
				prompt: details?.prompt ?? '',
				status:
					continuing || finish === undefined
						? 'running'
						: finish.outcome === 'completed'
							? 'done'
							: finish.outcome,
				turns: own.filter((entry) => entry._tag === 'assistant-message').length,
				tools: own.reduce(
					(count, entry) =>
						entry._tag === 'assistant-message' && typeof entry.message.content !== 'string'
							? count + entry.message.content.filter((part) => part.type === 'tool-call').length
							: count,
					0,
				),
				entries: own,
			}
		})
}

export const relativeSubagentTime = (calledAt: number, now = Date.now()): string => {
	const minutes = Math.floor(Math.max(0, now - calledAt) / 60_000)
	if (minutes < 1) return 'now'
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h`
	const days = Math.floor(hours / 24)
	if (days < 30) return `${days}d`
	const months = Math.floor(days / 30)
	if (months < 12) return `${months}mo`
	return `${Math.floor(months / 12)}y`
}

export const metaCounts = (entries: ReadonlyArray<LogEntry>, agents: ReadonlyArray<SubagentView>) => {
	const toolCalls = new Map<string, number>()
	for (const entry of entries) {
		if (entry._tag !== 'assistant-message' || typeof entry.message.content === 'string') continue
		for (const part of entry.message.content) {
			if (part.type === 'tool-call') toolCalls.set(part.name, (toolCalls.get(part.name) ?? 0) + 1)
		}
	}
	const agentTypes = new Map<string, number>()
	for (const agent of agents) agentTypes.set(agent.type, (agentTypes.get(agent.type) ?? 0) + 1)
	const assistantEntries = entries.filter((entry) => entry._tag === 'assistant-message')
	const contextTokens = assistantEntries.at(-1)?.finish?.usage.inputTokens?.total ?? 0
	const sparkRamp = '▁▂▃▄▅▆▇'
	const activity = entries
		.slice(-12)
		.map((entry) => (entry._tag === 'assistant-message' ? 3 : entry._tag === 'tool-result' ? 2 : 1))
	return {
		turns: assistantEntries.length,
		agents: agents.length,
		contextTokens,
		sparkline: activity.map((value) => sparkRamp[value] ?? '▁').join('') || '▁',
		tools: [...toolCalls.values()].reduce((sum, count) => sum + count, 0),
		toolCalls: [...toolCalls.entries()].sort((left, right) => right[1] - left[1]),
		agentTypes: [...agentTypes.entries()].sort((left, right) => right[1] - left[1]),
		running: agents.filter((agent) => agent.status === 'running').length,
		done: agents.filter((agent) => agent.status === 'done').length,
		errors: agents.filter((agent) => agent.status === 'error').length,
		stopped: agents.filter((agent) => agent.status === 'stopped').length,
		interrupted: agents.filter((agent) => agent.status === 'interrupted').length,
	}
}

export const skillViews = (entries: ReadonlyArray<LogEntry>, agentId: AgentId): ReadonlyArray<SkillView> => {
	const available = new Map<string, string>()
	const loaded = new Set<string>()
	const used = new Set<string>()
	for (const entry of entries) {
		if (entry.agentId !== agentId) continue
		if (entry._tag === 'system-message') {
			const block =
				JSON.stringify(entry.messages).match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0] ?? ''
			for (const match of block.matchAll(
				/<skill>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<description>(.*?)<\/description>[\s\S]*?<\/skill>/g,
			)) {
				const [, name, description] = match
				if (name !== undefined && description !== undefined) available.set(name, description)
			}
		}
		if (entry._tag === 'agent_started' && entry.skill !== null) loaded.add(entry.skill)
		if (entry._tag !== 'assistant-message' || typeof entry.message.content === 'string') continue
		for (const part of entry.message.content) {
			if (part.type !== 'tool-call' || part.name !== 'skill') continue
			const name = text(field(part.params, 'name'))
			if (name !== undefined) {
				available.set(name, available.get(name) ?? '')
				loaded.add(name)
				used.add(name)
			}
		}
	}
	return [...available.entries()]
		.map(([name, description]) => ({
			name,
			description,
			loaded: loaded.has(name),
			used: used.has(name),
		}))
		.sort((left, right) => left.name.localeCompare(right.name))
}
