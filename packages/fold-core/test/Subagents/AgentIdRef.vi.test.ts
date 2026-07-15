/**
 * Unit tests for the short agent-id reference layer: `shortAgentId` renders `agent_` + the first 8
 * cuid characters, and `resolveAgentIdRef` maps inbound references back onto known ids - exact full-id
 * match first, then unique short-prefix match, with distinct not-found and ambiguous outcomes. The
 * ambiguous branch is exercised with two ids sharing a full 8-character short id (the display-collision
 * edge) and with a shorter shared prefix whose candidates stay distinguishable.
 */
import { expect, it } from '@effect/vitest'

import { AgentId, isAgentIdRef, resolveAgentIdRef, shortAgentId } from '../../src/index'

const idWithCuid = (cuid: string): AgentId => AgentId.make(`agent_${cuid.padEnd(24, '0')}`)

const alpha = idWithCuid('alpha111')
const beta = idWithCuid('beta2222')
const twinOne = idWithCuid('abcdefgh1')
const twinTwo = idWithCuid('abcdefgh2')

it('shortAgentId keeps the prefix plus the first 8 cuid characters', () => {
	expect(shortAgentId(alpha)).toBe('agent_alpha111')
	expect(shortAgentId(idWithCuid('abcdefghijklmnop'))).toBe('agent_abcdefgh')
})

it('isAgentIdRef accepts full ids and short refs, and rejects everything else', () => {
	expect(isAgentIdRef(alpha)).toBe(true)
	expect(isAgentIdRef('agent_abcdef')).toBe(true)
	expect(isAgentIdRef('agent_ab12')).toBe(true) // 4 chars: the CLI tag form
	expect(isAgentIdRef('agent_abc')).toBe(false) // 3 chars: too short
	expect(isAgentIdRef('agent_ABCDEF')).toBe(false) // uppercase
	expect(isAgentIdRef('not-an-id')).toBe(false)
	expect(isAgentIdRef(`agent_${'a'.repeat(33)}`)).toBe(false) // longer than a full cuid segment
})

it('an exact full-id match wins immediately', () => {
	const resolution = resolveAgentIdRef([alpha, beta], alpha)
	expect(resolution).toEqual({ _tag: 'resolved', agentId: alpha })
})

it('a unique short prefix resolves to the full id', () => {
	const resolution = resolveAgentIdRef([alpha, beta], shortAgentId(beta))
	expect(resolution).toEqual({ _tag: 'resolved', agentId: beta })
	// The 4-char CLI tag form resolves too.
	expect(resolveAgentIdRef([alpha, beta], 'agent_beta')).toEqual({ _tag: 'resolved', agentId: beta })
})

it('an unknown reference and a full-length non-member are both not-found (no prefix match on full ids)', () => {
	expect(resolveAgentIdRef([alpha, beta], 'agent_zzzzzz')).toEqual({ _tag: 'not-found' })
	// A full 24-char id that is not a member never prefix-matches, even sharing a prefix with one.
	expect(resolveAgentIdRef([twinOne], `agent_abcdefgh${'9'.repeat(16)}`)).toEqual({ _tag: 'not-found' })
	expect(resolveAgentIdRef([alpha], 'not-a-ref')).toEqual({ _tag: 'not-found' })
})

it('two agents sharing the referenced prefix are ambiguous, carrying the candidate short ids', () => {
	const resolution = resolveAgentIdRef([twinOne, twinTwo, beta], 'agent_abcdef')
	expect(resolution._tag).toBe('ambiguous')
	if (resolution._tag !== 'ambiguous') return
	// Both twins share the full 8-char short id - the candidates report one entry per match.
	expect(resolution.candidates).toEqual(['agent_abcdefgh', 'agent_abcdefgh'])
})

it('candidates stay distinguishable when the shared prefix is shorter than the short id', () => {
	const nearOne = idWithCuid('abcdef11')
	const nearTwo = idWithCuid('abcdef22')
	const resolution = resolveAgentIdRef([nearOne, nearTwo], 'agent_abcdef')
	expect(resolution._tag).toBe('ambiguous')
	if (resolution._tag !== 'ambiguous') return
	expect(resolution.candidates).toEqual(['agent_abcdef11', 'agent_abcdef22'])
})
