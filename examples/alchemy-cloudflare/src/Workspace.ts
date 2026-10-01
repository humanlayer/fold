/**
 * Each session's workspace: the Computer Durable Object (see `computer/`) named by the session's id,
 * reached across scripts from ChatSession. Repos clone into `/workspace/<name>` when the session starts.
 */
import type { SessionId } from '@humanlayer/fold-core'
import type { RpcCallError } from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Context, Data, Effect, type FileSystem, Layer, Schema } from 'effect'

import {
	COMPUTER_WORKER_NAME,
	type ClonedRepo,
	type CommandInput,
	type CommandOutput,
	type ComputerResult,
	type RepoSpec,
} from './computer/Contract'
import { type ComputerFiles, workspaceFileSystem } from './WorkspaceFileSystem'

const REPO_NAME = /^(?!\.{1,2}$)[\w.-]+$/

/**
 * One repo to clone: an https URL, a `ref` (the remote's default branch when absent), and the directory
 * `name` under `/workspace` (the URL's last path segment when absent).
 */
export const Repo = Schema.Struct({
	url: Schema.String.check(Schema.isStartsWith('https://')),
	name: Schema.optionalKey(Schema.String),
	ref: Schema.optionalKey(Schema.String),
})
export type Repo = typeof Repo.Type

/** The directory a repo clones into, under `/workspace`. */
export const repoName = (repo: Repo) =>
	repo.name ?? (repo.url.replace(/\/+$/, '').split('/').at(-1) ?? '').replace(/\.git$/, '')

/** A session's repos: every directory name valid and distinct. */
export const Repos = Schema.Array(Repo).check(
	Schema.makeFilter((repos) => {
		const names = repos.map(repoName)
		const invalid = names.find((name) => !REPO_NAME.test(name))
		if (invalid !== undefined) return `repo directory name ${JSON.stringify(invalid)} is invalid; pass a "name"`
		return new Set(names).size === names.length || 'repo directory names must be distinct'
	}),
)

/** A repo failed to clone, so the session did not start. Crosses the ChatSession RPC boundary encoded. */
export class RepoCloneError extends Schema.TaggedError<RepoCloneError>()('RepoCloneError', {
	message: Schema.String,
}) {}

/** The shell could not run a command at all. A command that runs and fails is a {@link CommandOutput}. */
export class ShellError extends Data.TaggedError('ShellError')<{ readonly message: string }> {}

/** The Computer Durable Object, as ChatSession sees it. Its class lives in the Computer Worker. */
class Computer extends Cloudflare.DurableObject<
	Computer,
	ComputerFiles & {
		readonly prepare: (repos: ReadonlyArray<RepoSpec>) => Effect.Effect<ReadonlyArray<ClonedRepo>, RpcCallError>
		readonly exec: (input: CommandInput) => Effect.Effect<ComputerResult<CommandOutput>, RpcCallError>
		readonly expireAt: (deleteAt: number) => Effect.Effect<void, RpcCallError>
		readonly destroy: () => Effect.Effect<void, RpcCallError>
	}
>()('Computer') {}

export class Workspace extends Context.Service<
	Workspace,
	{
		/** Clone the session's repos fresh, replacing any clone a cut-off attempt left behind. */
		readonly prepare: (
			sessionId: SessionId,
			repos: ReadonlyArray<Repo>,
		) => Effect.Effect<ReadonlyArray<ClonedRepo>, RepoCloneError>
		/** The session's workspace as a `FileSystem`, for fold's file tools and skill loader. */
		readonly fileSystem: (sessionId: SessionId) => FileSystem.FileSystem
		/** Run one command in the session's shell. */
		readonly exec: (sessionId: SessionId, input: CommandInput) => Effect.Effect<CommandOutput, ShellError>
		/**
		 * Have the workspace delete itself at `deleteAt` (epoch milliseconds) unless moved again: the backup
		 * for a session that never deletes it. A failure is logged, not raised.
		 */
		readonly expireAt: (sessionId: SessionId, deleteAt: number) => Effect.Effect<void>
		/** Delete the workspace now. A failure is logged, not raised: the workspace's own deadline still holds. */
		readonly destroy: (sessionId: SessionId) => Effect.Effect<void>
	}
>()('alchemy-cloudflare/Workspace') {
	/** Binds the Computer Durable Object; build it in a Worker's or Durable Object's construction. */
	static readonly layer = Layer.effect(
		Workspace,
		Effect.gen(function* () {
			const computers = yield* Computer.from(COMPUTER_WORKER_NAME)

			return Workspace.of({
				prepare: Effect.fn('alchemy_cloudflare.workspace.prepare')((sessionId, repos) =>
					computers
						.getByName(sessionId)
						.prepare(repos.map((repo) => ({ name: repoName(repo), url: repo.url, ref: repo.ref ?? null })))
						.pipe(
							Effect.tap((cloned) =>
								Effect.logInfo('workspace.prepare', JSON.stringify({ sessionId, cloned })),
							),
							Effect.mapError((error) => new RepoCloneError({ message: error.message })),
						),
				),
				fileSystem: (sessionId) => workspaceFileSystem(computers.getByName(sessionId)),
				expireAt: (sessionId, deleteAt) =>
					computers
						.getByName(sessionId)
						.expireAt(deleteAt)
						.pipe(
							Effect.catch((error) =>
								Effect.logWarning(
									'workspace.expireAt failed',
									JSON.stringify({ sessionId, error: error.message }),
								),
							),
						),
				destroy: (sessionId) =>
					computers
						.getByName(sessionId)
						.destroy()
						.pipe(
							Effect.tap(() => Effect.logInfo('workspace.destroyed', JSON.stringify({ sessionId }))),
							Effect.catch((error) =>
								Effect.logWarning(
									'workspace.destroy failed',
									JSON.stringify({ sessionId, error: error.message }),
								),
							),
						),
				exec: Effect.fn('alchemy_cloudflare.workspace.exec')(function* (sessionId, input) {
					const result = yield* computers
						.getByName(sessionId)
						.exec(input)
						.pipe(Effect.mapError((error) => new ShellError({ message: error.message })))
					yield* Effect.logInfo(
						'workspace.exec',
						JSON.stringify({
							command: input.command,
							cwd: input.cwd,
							outcome: result.ok
								? { status: result.value.status, exitCode: result.value.exitCode }
								: result,
						}),
					)
					return result.ok ? result.value : yield* new ShellError({ message: result.message })
				}),
			})
		}),
	)
}
