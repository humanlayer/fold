import { describe, expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Result } from 'effect'

import {
	renderSkillContent,
	renderSkillsBlock,
	SkillNotFoundError,
	skillSourceFromData,
	type SkillMeta,
} from '../../src/index'

const demoSkills = [
	{ name: 'commit-helper', description: 'Craft commit messages', content: 'Write conventional commits.' },
	{
		name: 'pdf-report',
		description: 'Generate PDF reports',
		content: 'Use {baseDir}/references/layout.md.',
		baseDir: '/skills/pdf-report',
	},
]

describe('skillSourceFromData', () => {
	it.effect('lists metadata in declaration order', () =>
		Effect.gen(function* () {
			const source = yield* skillSourceFromData(demoSkills)
			const metas = yield* source.list

			expect(metas).toEqual([
				{ name: 'commit-helper', description: 'Craft commit messages' },
				{ name: 'pdf-report', description: 'Generate PDF reports' },
			])
		}),
	)

	it.effect('loads full skills with baseDir defaulted to null', () =>
		Effect.gen(function* () {
			const source = yield* skillSourceFromData(demoSkills)

			const inMemory = yield* source.load('commit-helper')
			expect(inMemory.baseDir).toBeNull()
			expect(inMemory.content).toBe('Write conventional commits.')

			const diskBacked = yield* source.load('pdf-report')
			expect(diskBacked.baseDir).toBe('/skills/pdf-report')
		}),
	)

	it.effect('fails load with the roster for unknown names', () =>
		Effect.gen(function* () {
			const source = yield* skillSourceFromData(demoSkills)
			const result = yield* source.load('nope').pipe(Effect.result)

			if (!Result.isFailure(result)) throw new Error('expected load to fail')
			expect(result.failure).toBeInstanceOf(SkillNotFoundError)
			if (result.failure._tag !== 'SkillNotFoundError') throw new Error('expected SkillNotFoundError')
			expect(result.failure.availableSkills).toEqual(['commit-helper', 'pdf-report'])
		}),
	)

	it.effect('dies on spec-invalid names: data-backed skills are host code', () =>
		Effect.gen(function* () {
			const exit = yield* skillSourceFromData([{ name: 'Bad--Name', description: 'x', content: 'y' }]).pipe(
				Effect.exit,
			)

			expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
		}),
	)

	it.effect('dies on duplicate names', () =>
		Effect.gen(function* () {
			const exit = yield* skillSourceFromData([
				{ name: 'dup', description: 'a', content: 'x' },
				{ name: 'dup', description: 'b', content: 'y' },
			]).pipe(Effect.exit)

			expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
		}),
	)
})

describe('renderSkillsBlock', () => {
	it('renders the listing with XML escaping and omits the block when empty', () => {
		const metas: ReadonlyArray<SkillMeta> = [{ name: 'a-skill', description: 'Handles <xml> & "quotes"' }]
		const block = renderSkillsBlock(metas)

		expect(block).toContain('<available_skills>')
		expect(block).toContain('<name>a-skill</name>')
		expect(block).toContain('Handles &lt;xml&gt; &amp; &quot;quotes&quot;')
		expect(renderSkillsBlock([])).toBeNull()
	})
})

describe('renderSkillContent', () => {
	it('wraps content with the skill name and baseDir note when present', () => {
		const rendered = renderSkillContent({
			name: 'pdf-report',
			content: 'Follow the layout.',
			baseDir: '/skills/pdf-report',
		})

		expect(rendered).toContain('<skill name="pdf-report" baseDir="/skills/pdf-report">')
		expect(rendered).toContain('resolve against /skills/pdf-report')
		expect(rendered).toContain('Follow the layout.')
		expect(rendered.endsWith('</skill>')).toBe(true)
	})

	it('omits baseDir attribute and note for data-backed skills', () => {
		const rendered = renderSkillContent({ name: 'commit-helper', content: 'Do the thing.', baseDir: null })

		expect(rendered).toContain('<skill name="commit-helper">')
		expect(rendered).not.toContain('baseDir')
	})
})
