/**
 * This file owns the rendering of unexpected failures into short, model-visible text. Both tool
 * settlement (defect -> tool execution failure, D12/D16) and the Subagents seam (subagent defect ->
 * result with an error message, D21) narrow raw Causes through these helpers, so the model always sees
 * the same escaped, truncated, single-line description regardless of which boundary caught the defect.
 */
import { Cause } from 'effect'

const maxModelVisibleErrorMessageLength = 300

/** Wrap model-facing runtime commentary in the system-information envelope. */
export const systemInformation = (message: string): string => `<system-information>${message}</system-information>`

/** Escape text embedded inside a system-information block. */
export const escapeSystemInformationContent = (message: string): string =>
	message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Collapse whitespace and cap the length of a model-visible error message. */
export const truncateModelVisibleErrorMessage = (message: string): string => {
	const singleLine = message.replace(/\s+/g, ' ').trim()

	if (singleLine.length <= maxModelVisibleErrorMessageLength) return singleLine

	return `${singleLine.slice(0, maxModelVisibleErrorMessageLength - 3)}...`
}

const stringifyUnknown = (value: unknown): string => {
	if (value instanceof Error) return value.message

	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

/** Render an unknown thrown/failed value as safe model-visible text. */
export const modelVisibleErrorDetailsFromUnknown = (value: unknown): string => {
	const raw = value instanceof Error ? value.message : stringifyUnknown(value)

	return escapeSystemInformationContent(truncateModelVisibleErrorMessage(raw === '' ? 'unknown error' : raw))
}

/** Render the first non-interrupt reason of a Cause as safe model-visible text. */
export const modelVisibleErrorDetailsFromCause = (cause: Cause.Cause<unknown>): string => {
	const reason = cause.reasons.find((reason) => !Cause.isInterruptReason(reason))

	if (reason === undefined) return 'unknown error'
	if (Cause.isDieReason(reason)) return modelVisibleErrorDetailsFromUnknown(reason.defect)
	if (Cause.isFailReason(reason)) return modelVisibleErrorDetailsFromUnknown(reason.error)

	return 'unknown error'
}
