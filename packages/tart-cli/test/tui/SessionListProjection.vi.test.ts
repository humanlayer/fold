import type { SessionSummary } from '@humanlayer/tart-agent'
import { SessionId } from '@humanlayer/tart-core'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { projectSessionRows } from '../../src/tui/SessionListProjection'

const summary = (suffix: string, status: SessionSummary['status']) => ({
	sessionId: Schema.decodeUnknownSync(SessionId)(`sess_${suffix.padEnd(24, 'x')}`),
	path: `/tmp/${suffix}.jsonl`,
	mtimeMs: 1,
	title: suffix,
	status,
	turns: 1,
	providerId: null,
	modelId: null,
	model: null,
	contextTokens: null,
	mode: null,
	rpi: false,
	profile: null,
	contextPercent: null,
})

describe('session list projection', () => {
	it('projects every truthful host phase and preserves unhosted durable rows', () => {
		const acquiring = summary('acquiring', 'stopped')
		const running = summary('running', 'stopped')
		const idle = summary('idle', 'running')
		const stopped = summary('stopped', 'running')
		const failed = summary('failed', 'ready')
		const durable = summary('durable', 'error')
		const rows = projectSessionRows(
			[acquiring, running, idle, stopped, failed, durable],
			[
				{ sessionId: acquiring.sessionId, phase: 'acquiring' },
				{ sessionId: running.sessionId, phase: 'live', status: 'RUNNING' },
				{ sessionId: idle.sessionId, phase: 'live', status: 'IDLE' },
				{ sessionId: stopped.sessionId, phase: 'live', status: 'STOPPED' },
				{ sessionId: failed.sessionId, phase: 'live', status: 'ERROR' },
			],
		)

		expect(rows.map((row) => row.status)).toEqual(['running', 'running', 'ready', 'stopped', 'error', 'error'])
		expect(rows[5]).toBe(durable)
	})
})
