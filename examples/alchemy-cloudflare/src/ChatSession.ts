/**
 * One fold session per Durable Object, named by its SessionId. The object's SQLite log is the session:
 * addressing a new id creates the object with an empty log, and its first `send` clones the message's repos
 * into the session's {@link Workspace} and starts the session under that id; a written log resumes on
 * activation. Callers never create a session explicitly.
 *
 * The agent reads and changes the repos' files through fold's file tools, runs commands in the workspace's
 * shell through {@link bashTool}, and loads skills from each repo's `.claude/skills` and `.agents/skills`.
 *
 * Every turn runs under a {@link Keepalive} lease so the object is not evicted mid-run. A turn can still
 * be cut off - a crash, a deploy - leaving the root's user message with no finished run after it. When a
 * written log activates in that state, the object nudges the root to continue.
 * Fold fills any tool call the cut left without a result, and the model can resume a cut-off subagent
 * by id itself. A turn that keeps getting cut off stops being nudged after {@link MAX_RESTART_NUDGES}.
 *
 * A session idle for 14 days deletes its workspace and itself; see
 * {@link SessionExpiry}. Its id then starts a new session.
 */
import { skillsFromDisk } from '@humanlayer/fold-agent/skills'
import { fileTools } from '@humanlayer/fold-agent/tools/files'
import {
	SessionId,
	type AgentId,
	type FoldSession,
	type LogEntry,
	type UserMessageLogEntry,
	defineAgent,
	eventLogSource,
	openaiModel,
	resumeSession,
	skillTool,
	startSession,
} from '@humanlayer/fold-core'
import * as Cloudflare from 'alchemy/Cloudflare'
import {
	Config,
	Effect,
	FileSystem,
	Match,
	Option,
	Path,
	Predicate,
	Result,
	Schema,
	Scope,
	Stream,
	SynchronizedRef,
} from 'effect'

import { bashTool } from './BashTool'
import type { Message, WhenRunning } from './ChatSessions'
import { WORKSPACE_ROOT } from './computer/Contract'
import { DurableObjectEventLog } from './DurableObjectEventLog'
import { Keepalive } from './Keepalive'
import { SessionExpiry } from './SessionExpiry'
import { type Repo, Workspace } from './Workspace'

const MODEL = 'gpt-5.6-terra'

/** The agent's home directory. Nothing is there unless the agent puts it there. */
const HOME = '/root'

const systemPrompt = (repoNames: ReadonlyArray<string>) =>
	[
		'You are a helpful, concise coding assistant.',
		repoNames.length === 0
			? 'No repos are cloned for this session.'
			: `This session's repos are cloned under ${WORKSPACE_ROOT}:\n${repoNames.map((name) => `- ${WORKSPACE_ROOT}/${name}`).join('\n')}`,
		'Use bash to list, search and inspect them, and the file tools to read and change files. Run bash in ' +
			"the container to install packages, build, and run tests. Files a repo's .gitignore lists, such as " +
			'node_modules and build output, exist only in the container.',
	].join('\n\n')

/** Skills from each repo's `.claude/skills` and `.agents/skills`, scanned once when the session opens. */
const repoSkills = (repoNames: ReadonlyArray<string>) =>
	skillTool(
		skillsFromDisk({
			cwd: WORKSPACE_ROOT,
			home: HOME,
			extraPaths: repoNames.flatMap((name) => [
				`${WORKSPACE_ROOT}/${name}/.claude/skills`,
				`${WORKSPACE_ROOT}/${name}/.agents/skills`,
			]),
		}),
	)

const RESTART_NUDGE =
	'<system-information>A restart cut you off before you finished. Continue where you left off.</system-information>'
const MAX_RESTART_NUDGES = 3

/** The workspace's backup deadline trails the session's by this much, so the session normally deletes both. */
const WORKSPACE_GRACE_MILLIS = 24 * 60 * 60 * 1000

/** The root's user messages since its last finished run: any means a restart cut that run off. */
const openRootMessages = (entries: ReadonlyArray<LogEntry>, rootAgentId: AgentId) => {
	const lastFinishedSeq =
		entries.findLast((entry) => Predicate.isTagged(entry, 'agent-finished') && entry.agentId === rootAgentId)
			?.seq ?? -1
	return entries.filter(
		(entry): entry is UserMessageLogEntry =>
			Predicate.isTagged(entry, 'user-message') && entry.agentId === rootAgentId && entry.seq > lastFinishedSeq,
	)
}

const isRestartNudge = ({ message }: UserMessageLogEntry) =>
	typeof message.content === 'string'
		? message.content === RESTART_NUDGE
		: message.content.some((part) => part.type === 'text' && part.text === RESTART_NUDGE)

/** The root's next `agent-finished` at or after `fromSeq`: the end of the run a steered message joined. */
const rootFinishedFrom = (session: FoldSession, fromSeq: number) =>
	session.events(fromSeq).pipe(
		Stream.filterMap((event) =>
			event.kind === 'log' &&
			Predicate.isTagged(event.entry, 'agent-finished') &&
			event.entry.agentId === session.rootAgentId
				? Result.succeed(event.entry)
				: Result.fail(event),
		),
		Stream.runHead,
		Effect.flatMap(Effect.fromOption),
		Effect.orDie,
	)

/**
 * Deliver one message to the root agent per {@link WhenRunning}. Idle roots just start a run. Only a
 * subagent target can be missing, so fold's `SubagentNotFoundError` cannot happen here.
 */
const deliver = (session: FoldSession, text: string, whenRunning: WhenRunning) =>
	Match.value(whenRunning).pipe(
		Match.when('queue', () => session.send(text)),
		Match.when('interrupt', () => Effect.andThen(session.interrupt(), session.send(text))),
		Match.when('steer', () =>
			Effect.gen(function* () {
				const fromSeq = (yield* session.entries).length
				yield* session.steer(text)
				return yield* rootFinishedFrom(session, fromSeq)
			}).pipe(Effect.catchTag('AgentNotRunningError', () => session.send(text))),
		),
		Match.exhaustive,
		Effect.catchTag('SubagentNotFoundError', (error) => Effect.die(error)),
	)

export default class ChatSession extends Cloudflare.DurableObject<ChatSession>()(
	'ChatSession',
	Effect.gen(function* () {
		const state = yield* Cloudflare.DurableObjectState
		// Read from the deploy environment and bound to the Worker as a secret. Missing, the deploy fails.
		const apiKey = yield* Config.redacted('OPENAI_API_KEY').pipe(Effect.orDie)
		const eventLogs = yield* DurableObjectEventLog
		const keepalive = yield* Keepalive
		const expiry = yield* SessionExpiry
		const workspace = yield* Workspace

		return Effect.gen(function* () {
			const sessionId = yield* Schema.decodeUnknownEffect(SessionId)(state.id.name)
			const eventLog = yield* eventLogs.open
			const log = eventLogSource(Effect.succeed(eventLog))
			const isEmpty = Option.isNone(yield* Stream.runHead(eventLog.entries()))

			const fileSystem = workspace.fileSystem(sessionId)
			const model = openaiModel({ apiKey, model: MODEL, reasoning: 'medium' })
			const agentFor = (repoNames: ReadonlyArray<string>) =>
				defineAgent({
					name: 'alchemy-cloudflare-chat',
					systemPrompt: systemPrompt(repoNames.toSorted()),
					model,
					tools: [
						...fileTools({ cwd: WORKSPACE_ROOT }),
						bashTool((input) => workspace.exec(sessionId, input)),
						repoSkills(repoNames),
					],
				})

			// Never closed: the session lives as long as the object stays in memory, past every call's own
			// scope. Opened on the first send, so reading an unknown id writes nothing.
			const scope = yield* Scope.make()

			// A new session clones its repos, starts its container in the background, then starts; a cut-off
			// start leaves the log empty, so the next send clones them again from scratch.
			const start = (repos: ReadonlyArray<Repo>) =>
				Effect.gen(function* () {
					const cloned = yield* workspace.prepare(sessionId, repos)
					yield* Effect.forkIn(workspace.startContainer(sessionId), scope)
					return yield* startSession({
						agent: agentFor(cloned.map((repo) => repo.name)),
						log,
						sessionId,
						cwd: WORKSPACE_ROOT,
						meta: { repos: cloned },
					})
				})

			// A written log's repos are the workspace's top-level directories.
			const resume = Effect.gen(function* () {
				const entries = yield* fileSystem.readDirectory(WORKSPACE_ROOT).pipe(Effect.orDie)
				const repoNames = yield* Effect.filter(entries, (name) =>
					fileSystem.stat(`${WORKSPACE_ROOT}/${name}`).pipe(
						Effect.map((info) => info.type === 'Directory'),
						Effect.orDie,
					),
				)
				return yield* resumeSession({ agent: agentFor(repoNames), log })
			})

			// Opened once, by whichever send or restart nudge comes first; `repos` only matter to a new session.
			const opened = yield* SynchronizedRef.make(Option.none<FoldSession>())
			const open = (repos: ReadonlyArray<Repo>) =>
				SynchronizedRef.modifyEffect(opened, (current) =>
					Option.match(current, {
						onSome: (session) => Effect.succeed([session, current] as const),
						onNone: () =>
							(isEmpty ? start(repos) : resume).pipe(
								// fold hands these to the file tools and the skill loader.
								Effect.provideService(FileSystem.FileSystem, fileSystem),
								Effect.provide(Path.layer),
								Scope.provide(scope),
								Effect.map((session) => [session, Option.some(session)] as const),
							),
					}),
				)

			// A written log may hold a turn a restart cut off: nudge the root to continue it, in the background
			// under a lease so the heartbeat keeps the object alive until it lands - even when that heartbeat's
			// alarm is the only thing that woke the object.
			// An expired session skips this and waits for its alarm: resuming would reach into the workspace
			// while it is being deleted, and could bring it back empty after.
			if (!isEmpty && !(yield* expiry.expired)) {
				yield* expiry.ensureScheduled
				yield* Effect.forkIn(
					Effect.gen(function* () {
						const session = yield* open([])
						const cutOff = openRootMessages(yield* session.entries, session.rootAgentId)
						if (cutOff.length === 0 || cutOff.filter(isRestartNudge).length >= MAX_RESTART_NUDGES) return
						yield* keepalive.whileRunning(deliver(session, RESTART_NUDGE, 'queue'))
					}),
					scope,
				)
			}

			return {
				send: ({ text, whenRunning, repos }: Message) =>
					keepalive.whileRunning(
						Effect.gen(function* () {
							const deadline = yield* expiry.touch
							yield* workspace.expireAt(sessionId, deadline + WORKSPACE_GRACE_MILLIS)
							return yield* deliver(yield* open(repos ?? []), text, whenRunning)
						}),
					),
				entries: () => Stream.runCollect(eventLog.entries()).pipe(Effect.orDie),
				// The heartbeat while a turn runs; after that, the idle deadline.
				alarm: () =>
					Effect.flatMap(keepalive.alarm, (running) =>
						running ? Effect.void : expiry.alarm(workspace.destroy(sessionId)),
					),
			}
		}).pipe(Effect.orDie)
	}).pipe(Effect.provide([DurableObjectEventLog.layer, Keepalive.layer, SessionExpiry.layer, Workspace.layer])),
) {}
