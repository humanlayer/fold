/**
 * D5 session layout/discovery tests: the project slug is deterministic and filesystem-safe, prepared
 * logs live at `<foldHome>/sessions/<slug>/<sess_id>.jsonl` with the directory created, a prepared log
 * round-trips a real session (`startSession({ sessionId, log })` records the SAME id the filename
 * carries), and discovery lists a project's logs newest-first with the latest ready for
 * `resumeSession`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { customModel, defineAgent, SessionId, startSession } from '@humanlayer/fold-core'
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
		expect(projectSlugFor('/Users/kyle/projects/fold')).toBe('Users-kyle-projects-fold')
		expect(projectSlugFor('/w e i r d//path!!')).toBe('w-e-i-r-d-path')
		expect(projectSlugFor('/')).toBe('root')
	}),
)

it.effect('prepareSessionLog mints the id, creates the directory, and derives the path from the id', () =>
	Effect.gen(function* () {
		const foldHome = yield* tempDir
		const cwd = '/some/project'

		const prepared = yield* prepareSessionLog({ cwd, foldHome })

		expect(prepared.path).toBe(join(foldHome, 'sessions', 'some-project', `${prepared.sessionId}.jsonl`))
		expect(prepared.path).toBe(sessionLogPathFor(prepared.sessionId, { cwd, foldHome }))

		// The directory exists: writing the log file needs no further setup.
		writeFileSync(prepared.path, '')
		const listed = yield* listSessionLogs({ cwd, foldHome })
		expect(listed.map((ref) => ref.sessionId)).toEqual([prepared.sessionId])
	}).pipe(Effect.scoped),
)

it.effect('a prepared log round-trips a session: the filename and session_started agree on the id', () =>
	Effect.gen(function* () {
		const foldHome = yield* tempDir
		const cwd = '/round/trip'
		const prepared = yield* prepareSessionLog({ cwd, foldHome })

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
		const foldHome = yield* tempDir
		const cwd = '/session/summaries'
		const prepared = yield* prepareSessionLog({ cwd, foldHome })
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
		yield* session.setTitle('Repair Flaky Picker')

		const summaries = yield* listSessionSummaries({ cwd, foldHome })

		expect(summaries).toHaveLength(1)
		expect(summaries[0]).toMatchObject({
			sessionId: prepared.sessionId,
			title: 'Repair Flaky Picker',
			status: 'ready',
			turns: 1,
			providerId: 'scripted',
			modelId: 'picker-model',
		})
	}).pipe(Effect.scoped),
)

it.effect('session summary index is a full fast path and latest valid record wins', () =>
	Effect.gen(function* () {
		const foldHome = yield* tempDir
		const cwd = '/summary/cache-fast-path'
		const prepared = yield* prepareSessionLog({ cwd, foldHome })
		const model = customModel({
			activeModel: {
				providerId: 'stub',
				providerKind: 'openai-compatible',
				modelId: 'picker',
				role: null,
				requestedReasoningLevel: 'off',
				reasoning: { _tag: 'disabled' },
			},
			make: LanguageModel.make({ generateText: () => Effect.die('unused'), streamText: () => Stream.empty }),
		})
		const session = yield* startSession({
			agent: defineAgent({ model }),
			log: prepared.log,
			sessionId: prepared.sessionId,
			cwd,
		})
		yield* session.send('Cache picker summaries')
		const [built] = yield* listSessionSummaries({ cwd, foldHome })
		if (built === undefined) throw new Error('expected summary')

		const indexPath = join(sessionsDirFor({ cwd, foldHome }), 'index.jsonl')
		const cached = JSON.parse(readFileSync(indexPath, 'utf8').trim())
		appendFileSync(
			indexPath,
			`${JSON.stringify({ ...cached, summary: { ...cached.summary, title: 'Latest Wins' } })}\n`,
		)
		const mtime = statSync(prepared.path).mtime
		const source = readFileSync(prepared.path, 'utf8')
		writeFileSync(prepared.path, 'x'.repeat(source.length))
		utimesSync(prepared.path, mtime, mtime)

		const [fast] = yield* listSessionSummaries({ cwd, foldHome })
		expect(fast?.title).toBe('Latest Wins')
		expect(fast?.turns).toBe(1)
	}).pipe(Effect.scoped),
)

it.effect('missing, corrupt, and stale summary records rebuild only their source logs', () =>
	Effect.gen(function* () {
		const foldHome = yield* tempDir
		const cwd = '/summary/cache-recovery'
		const prepared = yield* prepareSessionLog({ cwd, foldHome })
		const model = customModel({
			activeModel: {
				providerId: 'stub',
				providerKind: 'openai-compatible',
				modelId: 'picker',
				role: null,
				requestedReasoningLevel: 'off',
				reasoning: { _tag: 'disabled' },
			},
			make: LanguageModel.make({ generateText: () => Effect.die('unused'), streamText: () => Stream.empty }),
		})
		const session = yield* startSession({
			agent: defineAgent({ model }),
			log: prepared.log,
			sessionId: prepared.sessionId,
			cwd,
		})
		yield* session.send('Original title')
		const indexPath = join(sessionsDirFor({ cwd, foldHome }), 'index.jsonl')
		writeFileSync(indexPath, '{corrupt cache row\n')
		expect((yield* listSessionSummaries({ cwd, foldHome }))[0]?.title).toBe('Original title')

		yield* session.setTitle('Fresh From Authoritative Log')
		expect((yield* listSessionSummaries({ cwd, foldHome }))[0]?.title).toBe('Fresh From Authoritative Log')
		expect(readFileSync(indexPath, 'utf8')).toContain('Fresh From Authoritative Log')
	}).pipe(Effect.scoped),
)

it.effect('deletion never returns cached summaries and appends a tombstone', () =>
	Effect.gen(function* () {
		const foldHome = yield* tempDir
		const cwd = '/summary/cache-delete'
		const prepared = yield* prepareSessionLog({ cwd, foldHome })
		writeFileSync(prepared.path, '')
		yield* listSessionSummaries({ cwd, foldHome })
		yield* deleteSession(prepared.sessionId, { cwd, foldHome })
		expect(yield* listSessionSummaries({ cwd, foldHome })).toEqual([])
		expect(readFileSync(join(sessionsDirFor({ cwd, foldHome }), 'index.jsonl'), 'utf8')).toContain(
			'"_tag":"deleted"',
		)
	}).pipe(Effect.scoped),
)

it.effect("discovery lists a project's logs newest-first and ignores foreign files", () =>
	Effect.gen(function* () {
		const foldHome = yield* tempDir
		const cwd = '/discover/me'
		const directory = sessionsDirFor({ cwd, foldHome })

		const older = yield* prepareSessionLog({ cwd, foldHome })
		const newer = yield* prepareSessionLog({ cwd, foldHome })
		writeFileSync(older.path, '{}\n')
		writeFileSync(newer.path, '{}\n')
		writeFileSync(join(directory, 'notes.txt'), 'not a session')
		writeFileSync(join(directory, 'garbage.jsonl'), 'bad name')

		// Pin distinct mtimes so newest-first ordering is deterministic.
		utimesSync(older.path, new Date(1_000_000), new Date(1_000_000))
		utimesSync(newer.path, new Date(2_000_000), new Date(2_000_000))

		const listed = yield* listSessionLogs({ cwd, foldHome })
		expect(listed.map((ref) => ref.sessionId)).toEqual([newer.sessionId, older.sessionId])

		const latest = yield* latestSessionLog({ cwd, foldHome })
		expect(latest?.sessionId).toBe(newer.sessionId)
		expect(latest?.path).toBe(newer.path)

		// A project with no sessions directory lists empty, latest null.
		expect(yield* listSessionLogs({ cwd: '/never/used', foldHome })).toEqual([])
		expect(yield* latestSessionLog({ cwd: '/never/used', foldHome })).toBeNull()

		// Ids parse back as branded SessionIds.
		expect(SessionId.make(listed[0]?.sessionId ?? '')).toBe(newer.sessionId)
	}).pipe(Effect.scoped),
)

it.effect('deleting a session removes its event log and full tool-output directory', () =>
	Effect.gen(function* () {
		const foldHome = yield* tempDir
		const cwd = '/delete/me'
		const prepared = yield* prepareSessionLog({ cwd, foldHome })
		writeFileSync(prepared.path, '')
		const outputDirectory = toolOutputSessionDirFor({ sessionId: prepared.sessionId, foldHome })
		mkdirSync(outputDirectory, { recursive: true })
		writeFileSync(join(outputDirectory, 'tool_call_test.txt'), 'full paginated output')

		expect(yield* deleteSession(prepared.sessionId, { cwd, foldHome })).toEqual({
			deleted: true,
			outputRemoved: true,
		})
		expect(existsSync(prepared.path)).toBe(false)
		expect(existsSync(outputDirectory)).toBe(false)
		expect(yield* deleteSession(prepared.sessionId, { cwd, foldHome })).toEqual({
			deleted: false,
			outputRemoved: true,
		})
	}).pipe(Effect.scoped),
)
