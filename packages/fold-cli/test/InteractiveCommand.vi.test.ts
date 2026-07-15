/**
 * `parseInteractiveInput` is the readline loop's whole grammar, so every tag and every malformed shape
 * is asserted here: plain messages (trimmed), exit words, /help, /stop with and without a reason,
 * /steer and /send with the agent-reference guard (full ids or the short `agent_ab12cd34` form the
 * renderer displays), and instructive `invalid` results for everything else starting with a slash.
 */
import { expect, it } from '@effect/vitest'
import { AgentId } from '@humanlayer/fold-core'

import { parseInteractiveInput } from '../src/index'

const agentId = AgentId.make('agent_aaaaaaaaaaaaaaaaaaaaaaaa')

it('parses plain text as a trimmed message', () => {
	expect(parseInteractiveInput('fix the lint failure')).toEqual({ _tag: 'message', text: 'fix the lint failure' })
	expect(parseInteractiveInput('  padded input  ')).toEqual({ _tag: 'message', text: 'padded input' })
	expect(parseInteractiveInput('run /exit please')).toEqual({ _tag: 'message', text: 'run /exit please' })
	expect(parseInteractiveInput('')).toEqual({ _tag: 'message', text: '' })
	expect(parseInteractiveInput('   ')).toEqual({ _tag: 'message', text: '' })
})

it('parses the exit words, with or without a slash', () => {
	for (const line of ['/exit', 'exit', '/quit', 'quit', '  /exit  ']) {
		expect(parseInteractiveInput(line), line).toEqual({ _tag: 'exit' })
	}
	expect(parseInteractiveInput('/exit now')).toEqual({ _tag: 'invalid', message: '/exit takes no arguments' })
	expect(parseInteractiveInput('/quit now')).toEqual({ _tag: 'invalid', message: '/quit takes no arguments' })
})

it('parses /help', () => {
	expect(parseInteractiveInput('/help')).toEqual({ _tag: 'help' })
	expect(parseInteractiveInput('/help me')).toEqual({ _tag: 'invalid', message: '/help takes no arguments' })
})

it('parses /stop with an optional reason', () => {
	expect(parseInteractiveInput('/stop')).toEqual({ _tag: 'stop', reason: undefined })
	expect(parseInteractiveInput('/stop  ')).toEqual({ _tag: 'stop', reason: undefined })
	expect(parseInteractiveInput('/stop wrap it up')).toEqual({ _tag: 'stop', reason: 'wrap it up' })
})

it('parses /steer with a valid agent id and text', () => {
	expect(parseInteractiveInput(`/steer ${agentId} focus on the failing test`)).toEqual({
		_tag: 'steer',
		agentId,
		text: 'focus on the failing test',
	})
	// Inner spacing of the text survives; only the edges are trimmed.
	expect(parseInteractiveInput(`/steer ${agentId}   two  words `)).toEqual({
		_tag: 'steer',
		agentId,
		text: 'two  words',
	})
})

it('parses /send with a valid agent id and text', () => {
	expect(parseInteractiveInput(`/send ${agentId} continue where you left off`)).toEqual({
		_tag: 'send',
		agentId,
		text: 'continue where you left off',
	})
})

it('accepts the short agent-id form the renderer displays for /steer and /send', () => {
	expect(parseInteractiveInput('/steer agent_ab12cd34 focus on the failing test')).toEqual({
		_tag: 'steer',
		agentId: 'agent_ab12cd34',
		text: 'focus on the failing test',
	})
	expect(parseInteractiveInput('/send agent_ab12cd34 continue')).toEqual({
		_tag: 'send',
		agentId: 'agent_ab12cd34',
		text: 'continue',
	})
})

it('rejects /steer and /send with missing or malformed arguments', () => {
	for (const line of ['/steer', '/send', `/steer ${agentId}`, `/send ${agentId}  `]) {
		const command = parseInteractiveInput(line)
		expect(command._tag, line).toBe('invalid')
		if (command._tag === 'invalid') expect(command.message, line).toContain('usage:')
	}

	// `agent_ab` is below the 4-char reference floor; 4+ chars (the CLI tag form) are valid targets.
	for (const line of ['/steer not-an-id do things', '/send agent_ab do things']) {
		const command = parseInteractiveInput(line)
		expect(command._tag, line).toBe('invalid')
		if (command._tag === 'invalid') expect(command.message, line).toContain('is not an agent id')
	}
})

it('rejects unknown slash commands with a /help pointer', () => {
	for (const line of ['/frobnicate', '/', '/STOP now']) {
		const command = parseInteractiveInput(line)
		expect(command._tag, line).toBe('invalid')
		if (command._tag === 'invalid') expect(command.message, line).toContain('/help')
	}
})
