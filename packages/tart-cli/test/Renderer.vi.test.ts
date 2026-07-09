import { expect, it } from '@effect/vitest'
import { AgentId, MessageId, SessionId } from '@humanlayer/tart-core'
import { Effect } from 'effect'

import { makeOutputRenderer } from '../src/index'

it.effect('renders the session id in the header and finish line', () =>
	Effect.gen(function* () {
		const chunks: Array<string> = []
		const renderer = makeOutputRenderer({
			colors: false,
			stdout: (text) =>
				Effect.sync(() => {
					chunks.push(text)
				}),
		})
		const sessionId = SessionId.make('sess_aaaaaaaaaaaaaaaaaaaaaaaa')
		const agentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')
		const messageId = MessageId.make('msg_aaaaaaaaaaaaaaaaaaaaaaaa')

		yield* renderer.renderHeader({
			sessionId,
			cwd: '/tmp/project',
			logPath: '/tmp/tart/sessions/p/sess.jsonl',
			mode: 'new',
			model: {
				providerId: 'openai',
				providerKind: 'openai-compatible',
				modelId: 'gpt-test',
				role: 'smart',
				requestedReasoningLevel: 'off',
				reasoning: { _tag: 'disabled' },
			},
			credential: { _tag: 'found', detail: 'API key resolved for provider "openai"' },
		})
		yield* renderer.renderEvent({
			kind: 'log',
			entry: {
				_tag: 'assistant-message',
				seq: 2,
				ts: 1,
				agentId,
				parentAgentId: null,
				toolCallId: null,
				messageId,
				message: { options: {}, role: 'assistant', content: 'done text' },
				finish: {
					reason: 'stop',
					usage: {
						inputTokens: { uncached: 100, total: 100, cacheRead: 0, cacheWrite: undefined },
						outputTokens: { total: 10, text: 10, reasoning: 0 },
					},
				},
			},
		})
		yield* renderer.renderFinish({
			_tag: 'agent-finished',
			seq: 3,
			ts: 1,
			agentId,
			parentAgentId: null,
			toolCallId: null,
			outcome: 'completed',
			resultText: 'done text',
			reason: null,
		})

		const output = chunks.join('')
		expect(output).toContain(sessionId)
		expect(output).toContain(`session=${sessionId}`)
		expect(output).toContain(`agent=${agentId}`)
		expect(output).toContain(`resume tart --resume ${sessionId} --provider openai --model gpt-test --role smart`)
		expect(output).toContain('model openai/gpt-test')
		expect(output).toContain('credential found')
		expect(output).toContain('done text')
		expect(output).toContain('       0       --')
	}),
)
