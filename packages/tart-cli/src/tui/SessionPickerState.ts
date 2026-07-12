import type { SessionId } from '@humanlayer/tart-core'

export const shortSessionId = (sessionId: SessionId): string => sessionId.slice(0, 'sess_'.length + 6)

export const relativeSessionTime = (mtimeMs: number, now = Date.now()): string => {
	const elapsed = Math.max(0, now - mtimeMs)
	const minutes = Math.floor(elapsed / 60_000)
	if (minutes < 1) return 'now'
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}
