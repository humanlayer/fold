/**
 * Launch composition tests (D27): `launchSession` wires a resolved model + agentfiles + the mode's tool
 * roster into a real `startSession` over a JSONL log (D5 layout), and `resumeLatestSession` adopts the
 * newest log for the cwd. Uses a scripted `customModel` (no network) and real temp directories for the
 * workspace and tart home, so the JSONL persistence + agentfile discovery run end to end.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { customModel, type ActiveModel, type TartModel } from '@humanlayer/tart-core'
import { Effect, Stream } from 'effect'
import { LanguageModel, type Response } from 'effect/unstable/ai'

import {
	DEFAULT_CODING_PROMPT,
	defaultCodingMode,
	launchSession,
	mergeModelSelection,
	parseTartConfig,
	resumeLatestSession,
	resumeSessionById,
	RPI_HINT_PROMPT,
} from '../../src/index'
import { tempDir } from '../TestHelpers'

const openAiActiveModel = (modelId: string): ActiveModel => ({
	providerId: 'test',
	providerKind: 'openai-compatible',
	modelId,
	role: null,
	requestedReasoningLevel: 'off',
	reasoning: { _tag: 'disabled' },
})

const textParts = (text: string): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: 'text-start', id: 'text-1' },
	{ type: 'text-delta', id: 'text-1', delta: text },
	{ type: 'text-end', id: 'text-1' },
	{
		type: 'finish',
		reason: 'stop',
		response: undefined,
		// Concrete numbers (not undefined): the JSONL layer round-trips through JSON.stringify, which
		// drops undefined-valued keys - and Usage's fields are required keys - so undefined would fail
		// replay decoding. Real providers report numbers, so this matches production.
		usage: {
			inputTokens: { uncached: 10, total: 10, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 5, text: 5, reasoning: 0 },
		},
	},
]

/** A model that always streams `text` and finishes (fresh stream per request, so every send completes). */
const alwaysTextModel = (text: string): TartModel =>
	customModel({
		activeModel: openAiActiveModel('test-model'),
		make: LanguageModel.make({
			generateText: () => Effect.die(new Error('scripted model supports streamText only')),
			streamText: () => Stream.fromIterable(textParts(text)),
		}),
	})

const workspaceAndHome = (root: string): { readonly workspace: string; readonly tartHome: string } => {
	const workspace = join(root, 'work')
	const tartHome = join(root, 'tart')
	mkdirSync(workspace, { recursive: true })
	return { workspace, tartHome }
}

it.effect('launchSession composes the model, agentfiles, and mode tools over startSession', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)
		writeFileSync(join(workspace, 'AGENTS.md'), 'MEMORY-MARKER: follow the house rules.')

		yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* launchSession({
					model: alwaysTextModel('Done.'),
					cwd: workspace,
					tartHome,
					name: 'test-agent',
				})

				const finished = yield* session.send('hello')
				expect(finished.outcome).toBe('completed')
				expect(finished.resultText).toContain('Done.')

				const entries = yield* session.entries

				const started = entries.find((entry) => entry._tag === 'session_started')
				expect(started?._tag).toBe('session_started')
				if (started?._tag === 'session_started') {
					expect(started.cwd).toBe(workspace)
					expect(started.meta).toMatchObject({ mode: 'coding', rpi: false, profile: 'default' })
				}

				// The leading system message carries the mode prompt AND the agentfile project_context.
				const leading = entries.find(
					(entry) => entry._tag === 'system-message' && entry.placement === 'leading',
				)
				const leadingJson = JSON.stringify(leading)
				expect(leadingJson).toContain(DEFAULT_CODING_PROMPT)
				expect(leadingJson).toContain('Do not use emoticons.')
				expect(leadingJson).toContain('MEMORY-MARKER')
				expect(leadingJson).toContain('project_context')
				// Without rpi, the RPI hint block is absent.
				expect(leadingJson).not.toContain(RPI_HINT_PROMPT)

				// The mode's tool roster reached the agent (family-neutral + skill are always present).
				const agentStarted = entries.find((entry) => entry._tag === 'agent_started')
				const tools = agentStarted?._tag === 'agent_started' ? agentStarted.tools : []
				expect(tools).toContain('read')
				expect(tools).toContain('bash')
				expect(tools).toContain('skill')
				expect(tools).toContain('subagent')
			}),
		)
	}),
)

it.effect('launchSession with rpi appends the hint block after the mode prompt', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)

		yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* launchSession({
					model: alwaysTextModel('Done.'),
					cwd: workspace,
					tartHome,
					rpi: true,
				})

				const leading = (yield* session.entries).find(
					(entry) => entry._tag === 'system-message' && entry.placement === 'leading',
				)
				const leadingJson = JSON.stringify(leading)
				const started = (yield* session.entries).find((entry) => entry._tag === 'session_started')

				expect(leadingJson).toContain(DEFAULT_CODING_PROMPT)
				expect(leadingJson).toContain(RPI_HINT_PROMPT)
				if (started?._tag === 'session_started') expect(started.meta.rpi).toBe(true)
				// The hint composes AFTER the mode's own system prompt.
				expect(leadingJson.indexOf(RPI_HINT_PROMPT)).toBeGreaterThan(leadingJson.indexOf(DEFAULT_CODING_PROMPT))
			}),
		)
	}),
)

it.effect('resumeLatestSession adopts the newest log for the working directory', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)

		const first = yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* launchSession({ model: alwaysTextModel('Done.'), cwd: workspace, tartHome })
				yield* session.send('first message')
				const entries = yield* session.entries
				return { sessionId: session.sessionId, rootAgentId: session.rootAgentId, count: entries.length }
			}),
		)

		yield* Effect.scoped(
			Effect.gen(function* () {
				const resumed = yield* resumeLatestSession({
					model: alwaysTextModel('Again.'),
					cwd: workspace,
					tartHome,
				})

				// Adopts the same identity - no new session_started/agent_started.
				expect(resumed.sessionId).toBe(first.sessionId)
				expect(resumed.rootAgentId).toBe(first.rootAgentId)

				const entries = yield* resumed.entries
				expect(entries.length).toBeGreaterThanOrEqual(first.count)
				// The prior user message was replayed from disk.
				expect(JSON.stringify(entries)).toContain('first message')
			}),
		)
	}),
)

it.effect('resumeSessionById adopts an exact session id from the current project directory', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)

		const first = yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* launchSession({ model: alwaysTextModel('Done.'), cwd: workspace, tartHome })
				yield* session.send('remember this by id')
				return { sessionId: session.sessionId, rootAgentId: session.rootAgentId }
			}),
		)

		yield* Effect.scoped(
			Effect.gen(function* () {
				const resumed = yield* resumeSessionById(first.sessionId, {
					model: alwaysTextModel('Again.'),
					cwd: workspace,
					tartHome,
				})

				expect(resumed.sessionId).toBe(first.sessionId)
				expect(resumed.rootAgentId).toBe(first.rootAgentId)
				expect(JSON.stringify(yield* resumed.entries)).toContain('remember this by id')
			}),
		)
	}),
)

it.effect('resumeSessionById is scoped to the selected cwd project slug', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)
		const otherWorkspace = join(root, 'other-work')
		mkdirSync(otherWorkspace, { recursive: true })

		const sessionId = yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* launchSession({ model: alwaysTextModel('Done.'), cwd: workspace, tartHome })
				return session.sessionId
			}),
		)

		const error = yield* resumeSessionById(sessionId, {
			model: alwaysTextModel('x'),
			cwd: otherWorkspace,
			tartHome,
		}).pipe(Effect.scoped, Effect.flip)

		expect(error._tag).toBe('SessionToResumeNotFoundError')
	}),
)

it.effect('launchSession resolves CLI-style model selection overrides through tart-agent config', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)
		const config = yield* parseTartConfig(`{
			"providers": {
				"openai": { "kind": "openai-compat", "apiKey": "sk-inline" },
				"codex": { "kind": "codex" }
			},
			"roles": {
				"smart": { "provider": "openai", "model": "gpt-default" },
				"fast": { "provider": "codex", "model": "gpt-fast" }
			}
		}`)

		yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* launchSession({
					config,
					cwd: workspace,
					tartHome,
					modelSelection: { role: 'fast', model: 'gpt-override', reasoning: 'medium' },
				})
				const entries = yield* session.entries
				const agentStarted = entries.find((entry) => entry._tag === 'agent_started')

				expect(agentStarted?._tag).toBe('agent_started')
				if (agentStarted?._tag === 'agent_started') {
					expect(agentStarted.model.providerKind).toBe('codex')
					expect(agentStarted.model.modelId).toBe('gpt-override')
					expect(agentStarted.model.role).toBe('fast')
					expect(agentStarted.model.requestedReasoningLevel).toBe('medium')
				}
			}),
		)
	}),
)

it.effect('launchSession wires session profiles end to end: role-bound roster starts and setProfile works', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)
		const config = yield* parseTartConfig(`{
			"providers": {
				"openai": { "kind": "openai-compat", "apiKey": "sk-inline" }
			},
			"roles": {
				"smart": { "provider": "openai", "model": "gpt-smart" },
				"fast": { "provider": "openai", "model": "gpt-fast" }
			}
		}`)

		yield* Effect.scoped(
			Effect.gen(function* () {
				// The default roster is role-bound ('smart'/'fast'), so the session starting AT ALL proves
				// launchSession passed a covering profiles map through startSession's validation.
				const session = yield* launchSession({ config, cwd: workspace, tartHome })
				const started = (yield* session.entries).find((entry) => entry._tag === 'agent_started')
				expect(started?._tag).toBe('agent_started')

				// The facade's profile rebinding is reachable and typed on the launched session.
				yield* session.setProfile('fast', alwaysTextModel('rebound'))
			}),
		)
	}),
)

const namedProfileConfigText = `{
	"providers": {
		"openai": { "kind": "openai-compat", "apiKey": "sk-inline" }
	},
	"roles": {
		"smart": { "provider": "openai", "model": "gpt-default-smart" },
		"fast": { "provider": "openai", "model": "gpt-default-fast" }
	},
	"profiles": {
		"ultratest": {
			"mode": "rlm",
			"orchestrator": { "provider": "openai", "model": "gpt-ultra-orchestrator" },
			"smart": { "provider": "openai", "model": "gpt-ultra-smart" },
			"fast": { "provider": "openai", "model": "gpt-ultra-fast" }
		}
	}
}`

it.effect('--profile substitutes the profile roles and applies its pinned rlm mode', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)
		const config = yield* parseTartConfig(namedProfileConfigText)

		yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* launchSession({
					config,
					profile: 'ultratest',
					cwd: workspace,
					tartHome,
					catalog: [],
				})
				const started = (yield* session.entries).find((entry) => entry._tag === 'agent_started')

				expect(started?._tag).toBe('agent_started')
				if (started?._tag !== 'agent_started') return
				// The rlm mode pinned by the profile runs the primary on the ORCHESTRATOR role, and its
				// toolset carries no bash - both prove the profile's roles AND mode were applied.
				expect(started.model.modelId).toBe('gpt-ultra-orchestrator')
				expect(started.tools).not.toContain('bash')
				expect(started.tools).toContain('subagent')

				// RLM carries the RPI specialists BY DEFAULT: the hint block lands without any --rpi flag.
				const entries = yield* session.entries
				const leading = entries.find(
					(entry) => entry._tag === 'system-message' && entry.placement === 'leading',
				)
				expect(JSON.stringify(leading)).toContain(RPI_HINT_PROMPT)
			}),
		)
	}),
)

it.effect('an explicit mode option beats the profile pinned mode', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)
		const config = yield* parseTartConfig(namedProfileConfigText)

		yield* Effect.scoped(
			Effect.gen(function* () {
				const session = yield* launchSession({
					config,
					profile: 'ultratest',
					mode: defaultCodingMode,
					cwd: workspace,
					tartHome,
					catalog: [],
				})
				const started = (yield* session.entries).find((entry) => entry._tag === 'agent_started')

				expect(started?._tag).toBe('agent_started')
				if (started?._tag !== 'agent_started') return
				// Default mode wins: primary on the profile's SMART binding, bash back in the toolset.
				expect(started.model.modelId).toBe('gpt-ultra-smart')
				expect(started.tools).toContain('bash')
			}),
		)
	}),
)

it.effect('an unknown --profile fails with UnknownProfileError naming what exists', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)
		const config = yield* parseTartConfig(namedProfileConfigText)

		const error = yield* launchSession({ config, profile: 'nope', cwd: workspace, tartHome, catalog: [] }).pipe(
			Effect.scoped,
			Effect.flip,
		)

		expect(error._tag).toBe('UnknownProfileError')
		if (error._tag !== 'UnknownProfileError') return
		expect(error.profile).toBe('nope')
		expect(error.available).toEqual(['ultratest'])
	}),
)

it.effect('resumeLatestSession fails with NoSessionToResumeError when none exist for the cwd', () =>
	Effect.gen(function* () {
		const root = yield* tempDir
		const { workspace, tartHome } = workspaceAndHome(root)

		const error = yield* resumeLatestSession({ model: alwaysTextModel('x'), cwd: workspace, tartHome }).pipe(
			Effect.scoped,
			Effect.flip,
		)
		expect(error._tag).toBe('NoSessionToResumeError')
	}),
)

// --- mergeModelSelection: the CLI --provider/--model/--reasoning merge over a config binding ----------

const mergeConfigText = `{
	"providers": {
		"anthropic": { "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" },
		"codex": { "kind": "codex" },
		"openai": { "kind": "openai-compat", "apiKey": "sk-inline" },
		"openai-proxy": { "kind": "openai-compat", "apiKey": "sk-proxy", "baseUrl": "https://proxy.example/v1" }
	},
	"roles": {
		"smart": { "provider": "anthropic", "model": "claude-opus-4-8", "reasoning": "medium" },
		"fast": { "provider": "openai", "model": "gpt-5.6-luna" }
	}
}`

it.effect('mergeModelSelection drops the stale model when the newly named provider changes KIND', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(mergeConfigText)

		// `tart --provider codex` alone: the anthropic model id must NOT ride onto codex - the binding
		// comes back model-less so the codex default (gpt-5.6-sol) applies at resolution.
		const merged = mergeModelSelection(config, config.roles.smart, { provider: 'codex' })
		expect(merged).toEqual({ provider: 'codex', reasoning: 'medium' })
		expect(merged.model).toBeUndefined()
	}),
)

it.effect('mergeModelSelection keeps the configured model across a same-kind provider swap', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(mergeConfigText)

		const merged = mergeModelSelection(config, config.roles.fast, { provider: 'openai-proxy' })
		expect(merged).toEqual({ provider: 'openai-proxy', model: 'gpt-5.6-luna' })
	}),
)

it.effect('mergeModelSelection lets an explicit model selection win regardless of kind changes', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(mergeConfigText)

		const merged = mergeModelSelection(config, config.roles.smart, { provider: 'codex', model: 'gpt-5.6-sol' })
		expect(merged).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' })
	}),
)

it.effect('mergeModelSelection with no provider keeps the binding and overlays model/reasoning fields', () =>
	Effect.gen(function* () {
		const config = yield* parseTartConfig(mergeConfigText)

		expect(mergeModelSelection(config, config.roles.smart, {})).toEqual(config.roles.smart)
		expect(mergeModelSelection(config, config.roles.smart, { reasoning: 'high' })).toEqual({
			provider: 'anthropic',
			model: 'claude-opus-4-8',
			reasoning: 'high',
		})
	}),
)
