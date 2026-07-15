/**
 * This file defines short agent-id references: the display + inbound-resolution layer that lets models
 * and humans pass `agent_ab12cd34` (the first 8 characters of the cuid segment) instead of a full
 * 24-character id. Durable truth is untouched - the log, envelope, streams, and SessionControls stay
 * keyed by full branded ids everywhere - so this module is exactly two things: `shortAgentId` renders
 * the compact form for model-facing/CLI surfaces, and `resolveAgentIdRef` maps an inbound reference
 * (full id or unique short prefix) back onto the known ids projected from the log's `agent_started`
 * rows. Exact full-id matches always win; prefix matching only applies to refs short enough that they
 * cannot themselves be full ids (4-20 characters - a full cuid segment is 21-32). The 4-char floor
 * matches the CLI renderer's tag suffix, so an id read off a tag is always a valid reference.
 */
import { Schema } from 'effect'

import type { LogEntry } from '../EventLog/Schemas'
import type { AgentId } from '../Ids'

/** The inbound reference shape: `agent_` followed by 4-32 lowercase alphanumerics (full ids included). */
const refPattern = /^agent_[a-z0-9]{4,32}$/

/** Refs eligible for prefix matching: 4-20 chars can never be a full cuid segment (21-32 chars). */
const prefixRefPattern = /^agent_[a-z0-9]{4,20}$/

/** The cuid segment of an agent id or reference (everything after the `agent_` prefix). */
const cuidSegmentOf = (id: string): string => id.slice(id.lastIndexOf('_') + 1)

/** True when the input has the agent-id reference shape (a full id, or a short prefix reference). */
export const isAgentIdRef = (input: string): boolean => refPattern.test(input)

const agentIdRefFilter = Schema.makeFilter<string>(
	(input) =>
		isAgentIdRef(input)
			? undefined
			: `expected an agent id reference: "agent_" followed by 4-32 lowercase letters/digits`,
	{ identifier: 'AgentIdRef' },
)

/**
 * Schema for an inbound agent-id reference: a full `agent_<cuid>` id or a short prefix form like
 * `agent_ab12cd34`. Parsed as a plain string at the wire boundary and resolved to the full branded
 * {@link AgentId} inside the engine (exact match first, then unique prefix).
 */
export const AgentIdRef = Schema.String.check(agentIdRefFilter).annotate({ identifier: 'AgentIdRef' })
export type AgentIdRef = typeof AgentIdRef.Type

/**
 * The short display form of an agent id: `agent_` plus the first 8 characters of the cuid segment.
 * This is what models and humans see (subagent tool results, interrupt notes, CLI lines) and what
 * {@link resolveAgentIdRef} maps back onto the full id.
 */
export const shortAgentId = (agentId: AgentId): string => `agent_${cuidSegmentOf(agentId).slice(0, 8)}`

/** Outcome of resolving one inbound agent-id reference against the session's known agent ids. */
export type AgentIdRefResolution =
	| { readonly _tag: 'resolved'; readonly agentId: AgentId }
	| { readonly _tag: 'not-found' }
	/** Two or more known ids share the referenced prefix; `candidates` carries their SHORT ids. */
	| { readonly _tag: 'ambiguous'; readonly candidates: ReadonlyArray<string> }

/**
 * Resolve one inbound reference against the known agent ids (the log's `agent_started` rows). An exact
 * full-id match wins immediately; otherwise a reference of 4-20 characters prefix-matches the cuid
 * segment - a unique match resolves, zero matches is not-found, and two or more are ambiguous with the
 * candidates' short ids so the caller can ask for more characters.
 */
export const resolveAgentIdRef = (knownIds: Iterable<AgentId>, ref: string): AgentIdRefResolution => {
	const ids = [...knownIds]

	const exact = ids.find((id) => id === ref)
	if (exact !== undefined) return { _tag: 'resolved', agentId: exact }

	if (!prefixRefPattern.test(ref)) return { _tag: 'not-found' }

	const wanted = cuidSegmentOf(ref)
	const matches = ids.filter((id) => cuidSegmentOf(id).startsWith(wanted))
	const [single] = matches
	if (matches.length === 1 && single !== undefined) return { _tag: 'resolved', agentId: single }
	if (matches.length === 0) return { _tag: 'not-found' }

	return { _tag: 'ambiguous', candidates: matches.map(shortAgentId) }
}

/** The known agent ids of a session log: every `agent_started` row's id, in log order. */
export const agentIdsFromEntries = (entries: ReadonlyArray<LogEntry>): ReadonlyArray<AgentId> =>
	entries.flatMap((entry) => (entry._tag === 'agent_started' ? [entry.agentId] : []))
