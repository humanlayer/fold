import type { SessionSummary } from '@humanlayer/tart-agent'

import type { HostedSessionSnapshot } from './LiveSessionHost'
export type SessionRow = SessionSummary & { readonly contextPercent: number | null }

const projectedStatus = (snapshot: HostedSessionSnapshot): SessionSummary['status'] => {
	if (snapshot.phase === 'acquiring') return 'running'
	if (snapshot.status === 'RUNNING') return 'running'
	if (snapshot.status === 'STOPPED') return 'stopped'
	if (snapshot.status === 'ERROR') return 'error'
	if (snapshot.status === 'IDLE') return 'ready'
	return snapshot.status satisfies never
}

export const projectSessionRows = (
	durable: ReadonlyArray<SessionRow>,
	live: ReadonlyArray<HostedSessionSnapshot>,
): ReadonlyArray<SessionRow> => {
	const byId = new Map(live.map((snapshot) => [snapshot.sessionId, snapshot]))
	return durable.map((summary) => {
		const snapshot = byId.get(summary.sessionId)
		return snapshot === undefined ? summary : { ...summary, status: projectedStatus(snapshot) }
	})
}
