import { AgentId, type AgentStartedLogEntry, type LogEntry, MessageId } from '@humanlayer/fold-core'
import { describe, expect, it } from 'vitest'

import { relativeSubagentTime, skillViews, subagentViews } from '../src/tui/Subagents'

const startedEntry = (agentId: string, seq: number, ts: number): AgentStartedLogEntry => ({
	_tag: 'agent_started',
	seq,
	ts,
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
				ts: 1,
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
