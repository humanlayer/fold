import { SessionId } from '@humanlayer/tart-core'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeTuiRouter } from '../../src/tui/TuiRouter'
import { makeTuiSessionWorkspace } from '../../src/tui/TuiSessionWorkspace'

const sessionId = Schema.decodeUnknownSync(SessionId)('sess_workspacexxxxxxxxxxxxxxx')

describe('TuiSessionWorkspace', () => {
	it('admits one operation synchronously without changing the route', async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const router = makeTuiRouter({ _tag: 'picker' })
					const workspace = yield* makeTuiSessionWorkspace({
						tui: {
							cwd: '/tmp/tart-workspace-routing-test',
							tartHome: '/tmp/tart-workspace-routing-test-home',
						},
						configuration: { profiles: [], providers: [] },
						config: null,
						configNotice: null,
						loadSummariesOnStart: false,
					})

					const admitted = workspace.delete(sessionId)
					expect(Option.isSome(admitted)).toBe(true)
					expect(workspace.opening()).toBe(true)
					expect(Option.isNone(workspace.delete(sessionId))).toBe(true)
					expect(router.route()).toEqual({ _tag: 'picker' })

					if (Option.isSome(admitted)) yield* admitted.value

					expect(workspace.opening()).toBe(false)
					expect(router.route()).toEqual({ _tag: 'picker' })
				}),
			),
		)
	})
})
