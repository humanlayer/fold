import { AgentId, type LogEntry, MessageId } from '@humanlayer/fold-core'
import { describe, expect, it } from 'vitest'

import { skillViews } from '../src/tui/Subagents'

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
