import { Effect, Layer, Ref } from 'effect'

import { AgentId, CompactionId, Ids, MessageId, SessionId, StateId, ToolCallId } from '../../src/index'

export type DeterministicIdsOptions = {
	readonly start?: number
}

// Counter-LEADING layout: short-id truncation keeps the first 8 characters of the cuid segment, so the
// uniquifying counter must live at the head (`a0000001...`), never in the tail of a zero-padded string
// where every deterministic id would collapse onto one short id.
const deterministicCuid = (index: number) => `a${String(index).padStart(7, '0')}`.padEnd(24, '0')

const nextId = <A>(counter: Ref.Ref<number>, prefix: string, make: (id: string) => A): Effect.Effect<A> =>
	Ref.modify(counter, (index) => [make(`${prefix}_${deterministicCuid(index)}`), index + 1])

export const layerDeterministicIds = (options: DeterministicIdsOptions = {}): Layer.Layer<Ids> =>
	Layer.effect(
		Ids,
		Effect.gen(function* () {
			const counter = yield* Ref.make(options.start ?? 1)

			return {
				makeAgentId: nextId(counter, AgentId.prefix, (id) => AgentId.make(id)),
				makeCompactionId: nextId(counter, CompactionId.prefix, (id) => CompactionId.make(id)),
				makeMessageId: nextId(counter, MessageId.prefix, (id) => MessageId.make(id)),
				makeSessionId: nextId(counter, SessionId.prefix, (id) => SessionId.make(id)),
				makeStateId: nextId(counter, StateId.prefix, (id) => StateId.make(id)),
				makeToolCallId: nextId(counter, ToolCallId.prefix, (id) => ToolCallId.make(id)),
			}
		}),
	)
