import { expect, it } from '@effect/vitest'
import { AgentId } from '@humanlayer/fold-core'
import type { AgentFinishedLogEntry } from '@humanlayer/fold-core'
import { Effect } from 'effect'

import { ASSISTANT_RESPONSE_BEGIN, ASSISTANT_RESPONSE_END, makePromptOutputRenderer } from '../src/index'

const finished = (resultText: string | null): AgentFinishedLogEntry => ({
	_tag: 'agent-finished',
	seq: 3,
	ts: 1,
	agentId: AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa'),
	parentAgentId: null,
	toolCallId: null,
	outcome: 'completed',
	resultText,
	reason: null,
})

const render = (response: string | null, duplicate = false) =>
	Effect.gen(function* () {
		const stdout: Array<string> = []
		const stderr: Array<string> = []
		const renderer = makePromptOutputRenderer({
			colors: false,
			stdout: (text) => Effect.sync(() => void stdout.push(text)),
			stderr: (text) => Effect.sync(() => void stderr.push(text)),
		})
		yield* renderer.renderNote('startup note')
		yield* renderer.renderFinish(finished(response))
		if (duplicate) yield* renderer.renderFinish(finished(response))
		return { stdout: stdout.join(''), stderr: stderr.join('') }
	})

it.effect('frames multiline final response and sends all human details to stderr', () =>
	Effect.gen(function* () {
		const output = yield* render('first\nsecond')
		expect(output.stdout).toBe(`${ASSISTANT_RESPONSE_BEGIN}\nfirst\nsecond\n${ASSISTANT_RESPONSE_END}\n`)
		expect(output.stderr).toContain('startup note')
		expect(output.stderr).toContain('[done] completed')
	}),
)

it.effect('preserves a final newline without adding another', () =>
	Effect.gen(function* () {
		const output = yield* render('response\n')
		expect(output.stdout).toBe(`${ASSISTANT_RESPONSE_BEGIN}\nresponse\n${ASSISTANT_RESPONSE_END}\n`)
	}),
)

it.effect('frames an empty response', () =>
	Effect.gen(function* () {
		const output = yield* render('')
		expect(output.stdout).toBe(`${ASSISTANT_RESPONSE_BEGIN}\n\n${ASSISTANT_RESPONSE_END}\n`)
	}),
)

it.effect('suppresses duplicate finish frames', () =>
	Effect.gen(function* () {
		const output = yield* render('once', true)
		expect(output.stdout).toBe(`${ASSISTANT_RESPONSE_BEGIN}\nonce\n${ASSISTANT_RESPONSE_END}\n`)
	}),
)
