/**
 * D5 session layout/discovery tests: the project slug is deterministic and filesystem-safe, prepared
 * logs live at `<tartHome>/sessions/<slug>/<sess_id>.jsonl` with the directory created, a prepared log
 * round-trips a real session (`startSession({ sessionId, log })` records the SAME id the filename
 * carries), and discovery lists a project's logs newest-first with the latest ready for
 * `resumeSession`.
 */
import { existsSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { customModel, defineAgent, SessionId, startSession } from '@humanlayer/tart-core'
import { Effect, Stream } from 'effect'
import { LanguageModel } from 'effect/unstable/ai'

import {
	latestSessionLog,
	deleteSession,
	listSessionLogs,
	listSessionSummaries,
	prepareSessionLog,
	projectSlugFor,
	sessionLogPathFor,
	sessionsDirFor,
	toolOutputSessionDirFor,
} from '../../src/index'
import { tempDir } from '../TestHelpers'

it.effect('the project slug is a deterministic, filesystem-safe escape of the cwd', () =>
	Effect.sync(() => {
		expect(projectSlugFor('/Users/kyle/projects/tart')).toBe('Users-kyle-projects-tart')
		expect(projectSlugFor('/w e i r d//path!!')).toBe('w-e-i-r-d-path')
		expect(projectSlugFor('/')).toBe('root')
	}),
)

it.effect('prepareSessionLog mints the id, creates the directory, and derives the path from the id', () =>
	Effect.gen(function* () {
		const tartHome = yield* tempDir
		const cwd = '/some/project'

		const prepared = yield* prepareSessionLog({ cwd, tartHome })

		expect(prepared.path).toBe(join(tartHome, 'sessions', 'some-project', `${prepared.sessionId}.jsonl`))
		expect(prepared.path).toBe(sessionLogPathFor(prepared.sessionId, { cwd, tartHome }))

		// The directory exists: writing the log file needs no further setup.
		writeFileSync(prepared.path, '')
		const listed = yield* listSessionLogs({ cwd, tartHome })
		expect(listed.map((ref) => ref.sessionId)).toEqual([prepared.sessionId])
	}).pipe(Effect.scoped),
)

it.effect('a prepared log round-trips a session: the filename and session_started agree on the id', () =>
	Effect.gen(function* () {
		const tartHome = yield* tempDir
		const cwd = '/round/trip'
		const prepared = yield* prepareSessionLog({ cwd, tartHome })

		const model = customModel({
			activeModel: {
				providerId: 'scripted',
				providerKind: 'openai-compatible',
				modelId: 'scripted-model',
				role: null,
				requestedReasoningLevel: 'off',
				reasoning: { _tag: 'disabled' },
			},
			make: LanguageModel.make({
				generateText: () => Effect.die(new Error('unused')),
				streamText: () => Stream.empty,
			}),
		})

		const session = yield* startSession({
			agent: defineAgent({ model }),
			log: prepared.log,
			sessionId: prepared.sessionId,
			cwd,
		})
		expect(session.sessionId).toBe(prepared.sessionId)

		const entries = yield* session.entries
		const sessionStarted = entries.find((entry) => entry._tag === 'session_started')
		if (sessionStarted === undefined || sessionStarted._tag !== 'session_started') {
			throw new Error('expected session_started')
		}
		expect(sessionStarted.sessionId).toBe(prepared.sessionId)
	}).pipe(Effect.scoped),
)

it.effect('session summaries expose first-message titles, turns, and the active model', () =>
	Effect.gen(function* () {
		const tartHome = yield* tempDir
		const cwd = '/session/summaries'
		const prepared = yield* prepareSessionLog({ cwd, tartHome })
		const model = customModel({
			activeModel: {
				providerId: 'scripted',
				providerKind: 'openai-compatible',
				modelId: 'picker-model',
				role: null,
				requestedReasoningLevel: 'off',
				reasoning: { _tag: 'disabled' },
			},
			make: LanguageModel.make({
				generateText: () => Effect.die(new Error('unused')),
				streamText: () => Stream.empty,
			}),
		})
		const session = yield* startSession({
			agent: defineAgent({ model }),
			log: prepared.log,
			sessionId: prepared.sessionId,
			cwd,
		})
		yield* session.send('  Fix   the flaky picker test  ')

		const summaries = yield* listSessionSummaries({ cwd, tartHome })

		expect(summaries).toHaveLength(1)
		expect(summaries[0]).toMatchObject({
			sessionId: prepared.sessionId,
			title: 'Fix the flaky picker test',
			turns: 1,
			providerId: 'scripted',
			modelId: 'picker-model',
		})
	}).pipe(Effect.scoped),
)

it.effect("discovery lists a project's logs newest-first and ignores foreign files", () =>
	Effect.gen(function* () {
		const tartHome = yield* tempDir
		const cwd = '/discover/me'
		const directory = sessionsDirFor({ cwd, tartHome })

		const older = yield* prepareSessionLog({ cwd, tartHome })
		const newer = yield* prepareSessionLog({ cwd, tartHome })
		writeFileSync(older.path, '{}\n')
		writeFileSync(newer.path, '{}\n')
		writeFileSync(join(directory, 'notes.txt'), 'not a session')
		writeFileSync(join(directory, 'garbage.jsonl'), 'bad name')

		// Pin distinct mtimes so newest-first ordering is deterministic.
		utimesSync(older.path, new Date(1_000_000), new Date(1_000_000))
		utimesSync(newer.path, new Date(2_000_000), new Date(2_000_000))

		const listed = yield* listSessionLogs({ cwd, tartHome })
		expect(listed.map((ref) => ref.sessionId)).toEqual([newer.sessionId, older.sessionId])

		const latest = yield* latestSessionLog({ cwd, tartHome })
		expect(latest?.sessionId).toBe(newer.sessionId)
		expect(latest?.path).toBe(newer.path)

		// A project with no sessions directory lists empty, latest null.
		expect(yield* listSessionLogs({ cwd: '/never/used', tartHome })).toEqual([])
		expect(yield* latestSessionLog({ cwd: '/never/used', tartHome })).toBeNull()

		// Ids parse back as branded SessionIds.
		expect(SessionId.make(listed[0]?.sessionId ?? '')).toBe(newer.sessionId)
	}).pipe(Effect.scoped),
)

it.effect('deleting a session removes its event log and full tool-output directory', () =>
	Effect.gen(function* () {
		const tartHome = yield* tempDir
		const cwd = '/delete/me'
		const prepared = yield* prepareSessionLog({ cwd, tartHome })
		writeFileSync(prepared.path, '')
		const outputDirectory = toolOutputSessionDirFor({ sessionId: prepared.sessionId, tartHome })
		mkdirSync(outputDirectory, { recursive: true })
		writeFileSync(join(outputDirectory, 'tool_call_test.txt'), 'full paginated output')

		expect(yield* deleteSession(prepared.sessionId, { cwd, tartHome })).toEqual({
			deleted: true,
			outputRemoved: true,
		})
		expect(existsSync(prepared.path)).toBe(false)
		expect(existsSync(outputDirectory)).toBe(false)
		expect(yield* deleteSession(prepared.sessionId, { cwd, tartHome })).toEqual({
			deleted: false,
			outputRemoved: true,
		})
	}).pipe(Effect.scoped),
)
