import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Ref } from 'effect'

import {
	makeSkillTool,
	skillSourceFromData,
	StopController,
	ToolEvents,
	ToolState,
	type SkillMeta,
	type SkillSourceService,
	type ToolHandlerServices,
} from '../../src/index'

/** Ambient per-call services the runtime normally provides; the skill tool uses none of them. */
const ambientServices = Layer.mergeAll(
	Layer.succeed(ToolState, { get: () => Effect.succeed(null), set: () => Effect.void }),
	Layer.succeed(ToolEvents, { emit: () => Effect.void }),
	Layer.succeed(StopController, { requestStop: () => Effect.void, isStopRequested: Effect.succeed(false) }),
)

const skillContentOf = (result: unknown): string => {
	if (typeof result === 'object' && result !== null && 'content' in result && typeof result.content === 'string') {
		return result.content
	}
	throw new Error('expected a skill tool result with string content')
}

const runHandler = <A, E>(effect: Effect.Effect<A, E, ToolHandlerServices>) =>
	effect.pipe(Effect.provide(ambientServices))

const demoSkills = [
	{ name: 'commit-helper', description: 'Craft commit messages', content: 'Write conventional commits.' },
	{ name: 'reviewer', description: 'Review diffs', content: 'Look for bugs first.' },
]

describe('makeSkillTool', () => {
	it.effect('advertises the session-start roster in the description', () =>
		Effect.gen(function* () {
			const source = yield* skillSourceFromData(demoSkills)
			const snapshot = yield* source.list
			const tool = makeSkillTool({ source, snapshot })

			expect(tool.name).toBe('skill')
			expect(tool.tool.description).toContain('Available skills: commit-helper, reviewer.')
		}),
	)

	it.effect('loads a skill and wraps its content', () =>
		Effect.gen(function* () {
			const source = yield* skillSourceFromData(demoSkills)
			const snapshot = yield* source.list
			const tool = makeSkillTool({ source, snapshot })

			const result = yield* runHandler(tool.handler({ name: 'commit-helper' }))

			expect(result).toEqual({
				content: '<skill name="commit-helper">\nWrite conventional commits.\n</skill>',
			})
		}),
	)

	it.effect('returns an instructive failure with the roster for unknown skills', () =>
		Effect.gen(function* () {
			const source = yield* skillSourceFromData(demoSkills)
			const snapshot = yield* source.list
			const tool = makeSkillTool({ source, snapshot })

			const result = yield* runHandler(tool.handler({ name: 'missing' })).pipe(Effect.flip)

			expect(result).toEqual({
				message: 'Skill "missing" not found. Available skills: commit-helper, reviewer',
				availableSkills: ['commit-helper', 'reviewer'],
			})
		}),
	)

	it.effect('refresh reports skills added after the session-start snapshot', () =>
		Effect.gen(function* () {
			// A mutable source: the roster grows mid-session, but the snapshot stays fixed.
			const skills = yield* Ref.make<ReadonlyArray<SkillMeta>>([
				{ name: 'commit-helper', description: 'Craft commit messages' },
			])
			const source: SkillSourceService = {
				list: Ref.get(skills),
				load: (name) =>
					name === 'commit-helper' || name === 'late-arrival'
						? Effect.succeed({ name, description: 'x', content: `content of ${name}`, baseDir: null })
						: Effect.die(new Error('unused')),
			}
			const snapshot = yield* source.list
			const tool = makeSkillTool({ source, snapshot })

			yield* Ref.set(skills, [
				{ name: 'commit-helper', description: 'Craft commit messages' },
				{ name: 'late-arrival', description: 'Added mid-session' },
			])

			const result = yield* runHandler(tool.handler({ name: 'commit-helper', refresh: true }))
			const content = skillContentOf(result)

			expect(content).toContain('<skill name="commit-helper">')
			expect(content).toContain('<system-information>')
			expect(content).toContain('Skills added since session start:\n- late-arrival: Added mid-session')
		}),
	)

	it.effect('refresh reports an unchanged roster', () =>
		Effect.gen(function* () {
			const source = yield* skillSourceFromData(demoSkills)
			const snapshot = yield* source.list
			const tool = makeSkillTool({ source, snapshot })

			const result = yield* runHandler(tool.handler({ name: 'reviewer', refresh: true }))
			const content = skillContentOf(result)

			expect(content).toContain('The skill list has not changed since this session started.')
		}),
	)

	it.effect('an empty snapshot steers the model toward refresh', () =>
		Effect.gen(function* () {
			const source = yield* skillSourceFromData([])
			const tool = makeSkillTool({ source, snapshot: [] })

			expect(tool.tool.description).toContain('No skills were available when this session started')
		}),
	)
})
