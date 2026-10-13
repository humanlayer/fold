import {
	AgentId,
	type AgentStartedLogEntry,
	EventId,
	type LogEntry,
	MessageId,
	type TaskFinishedLogEntry,
	type TaskStartedLogEntry,
	ToolCallId,
} from '@humanlayer/fold-core'
import { describe, expect, it } from 'vitest'

import { metaCounts, relativeSubagentTime, skillViews, subagentViews } from '../src/tui/Subagents'

const startedEntry = (agentId: string, seq: number, ts: number): AgentStartedLogEntry => ({
	_tag: 'agent_started',
	seq,
	eventId: EventId.create(),
	ts,
	version: 1,
	agentId: AgentId.make(agentId),
	parentAgentId: AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa'),
	toolCallId: null,
	mode: 'fresh',
	model: {
		providerId: 'anthropic',
		providerKind: 'anthropic',
		modelId: 'fixture-model',
		role: null,
		requestedReasoningLevel: 'off',
		thinking: { _tag: 'disabled' },
	},
	tools: [],
	skill: null,
	fork: null,
	agentType: 'researcher',
})

describe('subagentViews', () => {
	it('sorts subagents in call order and retains their call time', () => {
		const rootAgentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
		const later = startedEntry('agent_cccccccccccccccccccccccc', 20, 2_000)
		const earlier = startedEntry('agent_bbbbbbbbbbbbbbbbbbbbbbbb', 10, 1_000)

		const views = subagentViews([later, earlier], rootAgentId)

		expect(views.map((view) => view.agentId)).toEqual([earlier.agentId, later.agentId])
		expect(views.map((view) => view.calledAt)).toEqual([1_000, 2_000])
	})
})

describe('relativeSubagentTime', () => {
	const now = 2_000_000_000_000

	it.each([
		[0, 'now'],
		[1 * 60_000, '1m'],
		[59 * 60_000, '59m'],
		[60 * 60_000, '1h'],
		[23 * 60 * 60_000, '23h'],
		[24 * 60 * 60_000, '1d'],
		[29 * 24 * 60 * 60_000, '29d'],
		[30 * 24 * 60 * 60_000, '1mo'],
		[365 * 24 * 60 * 60_000, '1y'],
	])('formats an age of %i milliseconds as %s', (age, expected) => {
		expect(relativeSubagentTime(now - age, now)).toBe(expected)
	})
})

describe('skillViews', () => {
	it('sorts skills alphabetically by name', () => {
		const agentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
		const entries: ReadonlyArray<LogEntry> = [
			{
				_tag: 'system-message',
				seq: 1,
				eventId: EventId.create(),
				ts: 1,
				version: 1,
				agentId,
				parentAgentId: null,
				toolCallId: null,
				messageId: MessageId.make('msg_aaaaaaaaaaaaaaaaaaaaaaaa'),
				placement: 'leading',
				messages: [
					{
						role: 'system',
						content:
							'<available_skills><skill><name>zebra</name><description>Last</description></skill><skill><name>Alpha</name><description>First</description></skill><skill><name>middle</name><description>Middle</description></skill></available_skills>',
					},
				],
			},
		]

		expect(skillViews(entries, agentId).map((skill) => skill.name)).toEqual(['Alpha', 'middle', 'zebra'])
	})
})

describe('background subagents in the rail', () => {
	const rootAgentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
	const started = startedEntry('agent_bbbbbbbbbbbbbbbbbbbbbbbb', 1, 1_000)
	const toolCallId = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa')
	const taskStarted: TaskStartedLogEntry = {
		_tag: 'task_started',
		seq: 2,
		eventId: EventId.create(),
		ts: 1_000,
		version: 1,
		agentId: started.agentId,
		parentAgentId: rootAgentId,
		toolCallId,
		taskType: 'subagent',
		agentType: 'researcher',
		description: 'find the loader',
		prompt: 'look',
		isBackgrounded: true,
		runCount: 1,
	}
	const taskFinished: TaskFinishedLogEntry = {
		_tag: 'task_finished',
		seq: 4,
		eventId: EventId.create(),
		ts: 2_000,
		version: 1,
		agentId: started.agentId,
		parentAgentId: rootAgentId,
		toolCallId,
		status: 'stopped',
		summary: null,
		error: null,
		usage: { turns: 0, toolUses: 0, totalTokens: null },
		durationMs: 1_000,
		lastToolName: null,
	}

	it('marks background agents, counts the running ones, and takes the label from the task', () => {
		const views = subagentViews([started, taskStarted], rootAgentId)
		expect(views).toEqual([
			expect.objectContaining({ background: true, status: 'running', description: 'find the loader' }),
		])
		expect(metaCounts([started, taskStarted], views).background).toBe(1)
	})

	it('reports how the background run ended', () => {
		const finished: LogEntry = {
			_tag: 'agent-finished',
			seq: 3,
			eventId: EventId.create(),
			ts: 2_000,
			version: 1,
			agentId: started.agentId,
			parentAgentId: rootAgentId,
			toolCallId,
			outcome: 'interrupted',
			resultText: null,
			reason: 'interrupted by the user',
		}
		const views = subagentViews([started, taskStarted, finished, taskFinished], rootAgentId)
		expect(views.map((view) => view.status)).toEqual(['stopped'])
		expect(metaCounts([], views).background).toBe(0)
	})
})
