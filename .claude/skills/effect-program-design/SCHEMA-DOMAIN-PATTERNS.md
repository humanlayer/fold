# Schema-First Domain Patterns

Use this when modeling Effect service inputs, outputs, durable events, command records, tagged errors, and IDs.
The rule: make the schema the source of truth, then derive the TypeScript type from it. Do not hand-write a
parallel object type that can drift from the schema.

## Defaults

- Model identity values as branded schemas, not raw strings.
- Model tagged domain variants with `Schema.TaggedClass`, not ad-hoc object unions.
- Model expected failures with `Schema.TaggedErrorClass`, not `Data.TaggedError`.
- Export both the schema/class value and the derived type: `export type X = typeof X.Type`.
- Use raw `string` for freeform text, provider-owned opaque strings, display labels, and external values that are
  not identity-bearing inside the domain.

## Branded IDs

```ts
import { makeBrandedId } from '@humanlayer/effect-branded-id'

/** ID for an organization in this domain. */
export const OrganizationId = makeBrandedId('org', { brand: 'OrganizationId' })
export type OrganizationId = typeof OrganizationId.Type

/** ID for a session-scoped agent. */
export const AgentId = makeBrandedId('agent', { brand: 'AgentId' })
export type AgentId = typeof AgentId.Type

/** ID for a persisted message. */
export const MessageId = makeBrandedId('msg', { brand: 'MessageId' })
export type MessageId = typeof MessageId.Type
```

Prefer branded IDs whenever two values could both be strings but must not be interchangeable. Branded IDs belong
in public service inputs and persisted schemas; callers should not pass positional bare strings.

```ts
export type WidgetService = {
	readonly listWidgets: (input: { readonly organizationId: OrganizationId }) => Effect.Effect<readonly Widget[]>
}
```

## Domain Scalars

Small constrained values should also start as schemas.

```ts
import { Schema } from 'effect'

export const LogSeq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: 'LogSeq',
})
export type LogSeq = typeof LogSeq.Type

export const EpochMillis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: 'EpochMillis',
})
export type EpochMillis = typeof EpochMillis.Type

export const ProviderKind = Schema.Literals(['anthropic', 'openai-compatible', 'codex']).annotate({
	identifier: 'ProviderKind',
})
export type ProviderKind = typeof ProviderKind.Type
```

Use literal schemas for closed vocabularies. Use branded IDs for identities. Use plain `Schema.String` only when
the value is truly freeform or provider-owned.

## Tagged Domain Classes

Use `Schema.TaggedClass` for persisted events, commands, state transitions, and other discriminated records.
This gives you constructors, schemas, encoders/decoders, and the `_tag` discriminator from one definition.

```ts
import { Schema } from 'effect'
import { makeBrandedId } from '@humanlayer/effect-branded-id'

export const AgentId = makeBrandedId('agent', { brand: 'AgentId' })
export type AgentId = typeof AgentId.Type

export const MessageId = makeBrandedId('msg', { brand: 'MessageId' })
export type MessageId = typeof MessageId.Type

export const LogSeq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ identifier: 'LogSeq' })
export type LogSeq = typeof LogSeq.Type

export const EpochMillis = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: 'EpochMillis',
})
export type EpochMillis = typeof EpochMillis.Type

const StoredEnvelopeFields = {
	seq: LogSeq,
	ts: EpochMillis,
} as const

const AgentScopedFields = {
	agentId: AgentId,
	parentAgentId: Schema.NullOr(AgentId),
} as const

export class UserMessageInput extends Schema.TaggedClass<UserMessageInput>()('user-message', {
	...AgentScopedFields,
	messageId: MessageId,
	text: Schema.String,
}) {}
export type UserMessageInput = typeof UserMessageInput.Type

export class UserMessageEntry extends Schema.TaggedClass<UserMessageEntry>()('user-message', {
	...StoredEnvelopeFields,
	...AgentScopedFields,
	messageId: MessageId,
	text: Schema.String,
}) {}
export type UserMessageEntry = typeof UserMessageEntry.Type

export class ToolResultInput extends Schema.TaggedClass<ToolResultInput>()('tool-result', {
	...AgentScopedFields,
	messageId: MessageId,
	output: Schema.String,
}) {}
export type ToolResultInput = typeof ToolResultInput.Type

export class ToolResultEntry extends Schema.TaggedClass<ToolResultEntry>()('tool-result', {
	...StoredEnvelopeFields,
	...AgentScopedFields,
	messageId: MessageId,
	output: Schema.String,
}) {}
export type ToolResultEntry = typeof ToolResultEntry.Type

export const LogEntryInput = Schema.Union([UserMessageInput, ToolResultInput]).annotate({
	identifier: 'LogEntryInput',
	discriminator: '_tag',
})
export type LogEntryInput = typeof LogEntryInput.Type

export const LogEntry = Schema.Union([UserMessageEntry, ToolResultEntry]).annotate({
	identifier: 'LogEntry',
	discriminator: '_tag',
})
export type LogEntry = typeof LogEntry.Type
```

Keep repeated field groups as schema field constants (`StoredEnvelopeFields`, `AgentScopedFields`) instead of
duplicating TypeScript object types. If a variant has invariants, pass a checked `Schema.Struct` to
`Schema.TaggedClass` and derive the type from the class.

```ts
type AgentRunContext = {
	readonly parentAgentId: AgentId | null
	readonly toolCallId: ToolCallId | null
}

const AgentRunContextFilter = Schema.makeFilter<AgentRunContext>(
	({ parentAgentId, toolCallId }) => {
		const bothNull = parentAgentId === null && toolCallId === null
		const bothSet = parentAgentId !== null && toolCallId !== null

		return bothNull || bothSet ? undefined : 'parentAgentId and toolCallId must both be null or both be set'
	},
	{ identifier: 'AgentRunContext' },
)

export class AgentStartedInput extends Schema.TaggedClass<AgentStartedInput>()(
	'agent-started',
	Schema.Struct({
		agentId: AgentId,
		parentAgentId: Schema.NullOr(AgentId),
		toolCallId: Schema.NullOr(ToolCallId),
		model: Schema.String,
	}).check(AgentRunContextFilter),
) {}
export type AgentStartedInput = typeof AgentStartedInput.Type
```

The helper `type AgentRunContext` is acceptable because it exists only to type the filter callback. It is not a
public domain type and does not duplicate an exported schema contract.

## Tagged Errors

Use `Schema.TaggedErrorClass` for typed expected failures. Error fields should be safe to log and structured for
recovery. Model the caller action, not the transport status.

```ts
import { Schema } from 'effect'

import { OrganizationId } from './ids'

export const WidgetOperation = Schema.Literals(['list', 'sync', 'notify']).annotate({
	identifier: 'WidgetOperation',
})
export type WidgetOperation = typeof WidgetOperation.Type

export class WidgetUnavailableError extends Schema.TaggedErrorClass<WidgetUnavailableError>()(
	'WidgetUnavailableError',
	{
		operation: WidgetOperation,
		retryable: Schema.Boolean,
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

export class WidgetNeedsReauthError extends Schema.TaggedErrorClass<WidgetNeedsReauthError>()(
	'WidgetNeedsReauthError',
	{
		operation: WidgetOperation,
		organizationId: OrganizationId,
		message: Schema.String,
	},
) {}

export type WidgetError = WidgetUnavailableError | WidgetNeedsReauthError
```

Avoid `cause: unknown` in the schema. Prefer `cause: Schema.optional(Schema.Defect())`, and keep raw inspection at
the adapter boundary before mapping into a tagged error.

## Boundary Parsing

Decode at trust boundaries and keep service internals typed.

```ts
const decodeLogEntry = (input: unknown): Effect.Effect<LogEntry, ParseError> =>
	Schema.decodeUnknownEffect(LogEntry)(input)

const encodeLogEntry = (entry: LogEntry): Effect.Effect<typeof LogEntry.Encoded, ParseError> =>
	Schema.encodeUnknownEffect(LogEntry)(entry)
```

Use `Schema.decodeUnknownEffect` for inbound JSON, webhooks, CLI input, provider responses, and JSONL/database
JSON blobs. Use `Schema.encodeUnknownEffect` before persisting or sending schema-modeled values across a wire.

## Anti-Patterns

```ts
// Wrong: schema and type can drift.
export const UserMessage = Schema.Struct({
	messageId: MessageId,
	text: Schema.String,
})
export type UserMessage = {
	readonly messageId: string
	readonly text: string
}

// Wrong: identity values are interchangeable strings.
export type AppendInput = {
	readonly agentId: string
	readonly messageId: string
}

// Wrong: tagged union exists only in TypeScript and cannot decode/encode itself.
export type LogEntry =
	| { readonly _tag: 'user-message'; readonly messageId: MessageId; readonly text: string }
	| { readonly _tag: 'tool-result'; readonly messageId: MessageId; readonly output: string }

// Wrong: expected error is not schema-modeled.
export class WidgetUnavailableError extends Data.TaggedError('WidgetUnavailableError')<{
	readonly message: string
	readonly cause?: unknown
}> {}
```

Prefer the schema/class value as the contract. The type alias is derived documentation for TypeScript, not a
second source of truth.
