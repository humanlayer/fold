import { homedir } from 'node:os'
import { join } from 'node:path'

import * as NodePath from '@effect/platform-node/NodePath'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { resolveToCwd } from '../../src/Fs/PathResolve'

it.effect('expands a home-relative configured working directory to an absolute path', () =>
	Effect.gen(function* () {
		expect(yield* resolveToCwd('~/.humanlayer/workspaces/example', process.cwd())).toBe(
			join(homedir(), '.humanlayer', 'workspaces', 'example'),
		)
	}).pipe(Effect.provide(NodePath.layer)),
)
