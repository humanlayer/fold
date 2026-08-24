import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'

import { cwdFor } from '../../src/Fs/DefaultFileSystem'

it('expands a home-relative configured working directory to an absolute path', () => {
	expect(cwdFor({ cwd: '~/.humanlayer/workspaces/example' })).toBe(
		join(homedir(), '.humanlayer', 'workspaces', 'example'),
	)
})
