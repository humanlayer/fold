import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { parseSkillFile, skillNameOr, splitSkillFile } from '../../src/Skills/SkillFrontmatter'

it.effect('parses frontmatter fields and the trimmed body, ignoring unknown keys', () =>
	Effect.gen(function* () {
		const document = yield* parseSkillFile(
			['---', 'name: deploy', 'description: Ship it', 'allowed-tools: [Bash]', '---', '', 'Body.', ''].join('\n'),
		)

		expect(document).toEqual({ frontmatter: { name: 'deploy', description: 'Ship it' }, body: 'Body.' })
	}),
)

it.effect('decodes a bare key as null and an absent key as missing', () =>
	Effect.gen(function* () {
		const { frontmatter } = yield* parseSkillFile(['---', 'name:', '---', 'Body.'].join('\n'))

		expect(frontmatter).toEqual({ name: null })
		expect(skillNameOr(frontmatter, 'from-dir')).toBe('from-dir')
	}),
)

it.effect('normalizes CRLF and CR so no field carries a trailing \\r', () =>
	Effect.gen(function* () {
		const crlf = yield* parseSkillFile(['---', 'description: Windows', 'name: crlf', '---', 'Body.'].join('\r\n'))
		const cr = yield* parseSkillFile(['---', 'name: cr', '---', 'Body.'].join('\r'))

		expect(crlf).toEqual({ frontmatter: { name: 'crlf', description: 'Windows' }, body: 'Body.' })
		expect(cr).toEqual({ frontmatter: { name: 'cr' }, body: 'Body.' })
	}),
)

it.effect('fails with SkillFrontmatterMissing when there is no frontmatter block', () =>
	Effect.gen(function* () {
		const plain = yield* parseSkillFile('just markdown').pipe(Effect.flip)
		const unclosed = yield* parseSkillFile('---\nname: open\nno closing fence').pipe(Effect.flip)

		expect(plain._tag).toBe('SkillFrontmatterMissing')
		expect(unclosed._tag).toBe('SkillFrontmatterMissing')
		expect(splitSkillFile('# Title\r\n\r\nText.\r\n')).toEqual({
			frontmatter: Option.none(),
			body: '# Title\n\nText.',
		})
	}),
)

it.effect('fails with SkillFrontmatterInvalidYaml when the YAML does not parse', () =>
	Effect.gen(function* () {
		const error = yield* parseSkillFile('---\nname: [unterminated\n---\nBody').pipe(Effect.flip)

		expect(error._tag).toBe('SkillFrontmatterInvalidYaml')
	}),
)

it.effect('fails with SkillFrontmatterInvalidFields for wrong field types or a non-mapping document', () =>
	Effect.gen(function* () {
		const numericName = yield* parseSkillFile('---\nname: 42\ndescription: ok\n---\nBody').pipe(Effect.flip)
		const listDescription = yield* parseSkillFile('---\ndescription: [a, b]\n---\nBody').pipe(Effect.flip)
		const scalarDocument = yield* parseSkillFile('---\njust a string\n---\nBody').pipe(Effect.flip)
		const emptyDocument = yield* parseSkillFile('---\n---\nBody').pipe(Effect.flip)

		expect([numericName, listDescription, scalarDocument, emptyDocument].map(({ _tag }) => _tag)).toEqual([
			'SkillFrontmatterInvalidFields',
			'SkillFrontmatterInvalidFields',
			'SkillFrontmatterInvalidFields',
			'SkillFrontmatterInvalidFields',
		])
	}),
)
