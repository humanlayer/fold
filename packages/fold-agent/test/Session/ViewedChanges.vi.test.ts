import { expect, it } from '@effect/vitest'
import { SessionId } from '@humanlayer/fold-core'
import { Effect } from 'effect'

import { loadViewedPatchHashes, saveViewedPatchHash } from '../../src/index'
import { memoryFileSystem } from '../TestHelpers'

it.effect('persists latest viewed patch hashes per session and ignores corrupt records', () =>
	Effect.gen(function* () {
		const fs = memoryFileSystem({})
		const first = SessionId.make('sess_aaaaaaaaaaaaaaaaaaaaaaaa')
		const second = SessionId.make('sess_bbbbbbbbbbbbbbbbbbbbbbbb')
		const options = { fileSystem: fs, cwd: '/repo', foldHome: '/home/user/.fold' }

		yield* saveViewedPatchHash(first, 'unstaged:app.ts', 'old', options)
		yield* saveViewedPatchHash(second, 'unstaged:app.ts', 'other-session', options)
		yield* fs.writeFileString('/home/user/.fold/sessions/repo/viewed-changes.jsonl', '{truncated\n', { flag: 'a' })
		yield* saveViewedPatchHash(first, 'unstaged:app.ts', 'new', options)

		expect(yield* loadViewedPatchHashes(first, options)).toEqual({ 'unstaged:app.ts': 'new' })
		expect(yield* loadViewedPatchHashes(second, options)).toEqual({ 'unstaged:app.ts': 'other-session' })
	}),
)
