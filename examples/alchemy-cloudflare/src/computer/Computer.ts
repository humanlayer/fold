/// <reference types="@cloudflare/workers-types/experimental" />
/**
 * The Computer Durable Object: one `@cloudflare/computer` Workspace per fold session, named by its
 * SessionId. The Workspace is a virtual filesystem in the object's SQLite, with git, and two places to run
 * commands on it:
 *
 * - `shell`: just-bash in a Worker the Worker Loader starts, which reads and writes this same filesystem.
 * - `container`: this object's Linux container (see `Dockerfile`), running `computerd`, which mounts a copy
 *   of the filesystem at `/workspace`. Each command first sends the container the files changed since the
 *   last one, then copies back what the command changed.
 *
 * A plain Durable Object rather than an Effect one, because `withWorkspace` must wrap the
 * `cloudflare:workers` class.
 */
import { type DurableObjectStorageLike, getWorkspace, withWorkspace } from '@cloudflare/computer'
import {
	CloudflareContainerBackend,
	type CloudflareContainerBackendOptions,
	type IWorkspaceContainerAPI,
	type WorkspaceContainerAPI,
	withWorkspaceContainer,
} from '@cloudflare/computer/backends/container'
import { WorkerShellBackend } from '@cloudflare/computer/backends/worker-shell'
import { createGitClient, type GitClient, type GitCloneOptions } from '@cloudflare/computer/git'
import jq from '@cloudflare/computer/shell/jq'
import { DurableObject } from 'cloudflare:workers'
import { Data, Effect, Option, Schema } from 'effect'

import {
	type Backend,
	type ClonedRepo,
	type CommandInput,
	type CommandOutput,
	COMPUTER_BINDING,
	type ComputerResult,
	type FileInfo,
	type RepoSpec,
	WORKSPACE_ROOT,
} from './Contract'

// Entrypoints the backends reach this object through, via `ctx.exports`: the shell calls back into the
// workspace through WorkspaceServiceProxy, and the container dials its connection in through WorkspaceProxy.
export { WorkspaceProxy, WorkspaceServiceProxy } from '@cloudflare/computer'

type Env = {
	/** Starts the shell's Worker. */
	readonly LOADER: WorkerLoader
}

/** How long `startContainer` waits for the no-op command, past the container's own 30s start budget. */
const CONTAINER_START_TIMEOUT_MILLIS = 10_000

/** How long `destroy` waits after answering before the object restarts. */
const RESTART_DELAY_MILLIS = 1_000

/**
 * The object's storage as `@cloudflare/computer` types it. Its `exec` promises whatever row type the caller
 * names, which a Durable Object's SQL cannot; the rows are the same at runtime.
 */
const workspaceStorage = (storage: DurableObjectStorage): DurableObjectStorageLike => {
	function exec<Row extends object>(query: string, ...bindings: Array<unknown>): { toArray(): Array<Row> }
	function exec(query: string, ...bindings: Array<unknown>): { toArray(): Array<object> } {
		return storage.sql.exec(query, ...bindings)
	}
	return {
		sql: { exec },
		transaction: (closure) => storage.transaction(async () => closure()),
		transactionSync: (closure) => storage.transactionSync(closure),
	}
}

/** What `withWorkspaceContainer` adds to the object. */
type ContainerOwner = {
	getWorkspaceContainer(): WorkspaceContainerAPI | IWorkspaceContainerAPI | Promise<IWorkspaceContainerAPI>
}

/**
 * The object as the container backend's host. `@cloudflare/computer` types the container API against its
 * own copy of the Workers types, whose `Fetcher` has more methods than ours; the object is the same.
 */
function containerHost(self: ContainerOwner): Awaited<ReturnType<CloudflareContainerBackendOptions['container']>>
function containerHost(self: ContainerOwner): ContainerOwner {
	return self
}

/** A thrown workspace error carries its POSIX-style code, like `ENOENT`. */
const ErrorCode = Schema.Struct({ code: Schema.String })
const errorCodeOf = (cause: unknown): string =>
	Option.match(Schema.decodeUnknownOption(ErrorCode)(cause), { onNone: () => 'UNKNOWN', onSome: ({ code }) => code })

class WorkspaceOperationError extends Data.TaggedError('WorkspaceOperationError')<{
	readonly code: string
	readonly message: string
}> {}

/** Run one file operation, returning a thrown workspace error as its code and message. */
const attempt = <A>(operation: () => Promise<A>): Promise<ComputerResult<A>> =>
	Effect.runPromise(
		Effect.tryPromise({
			try: operation,
			catch: (cause) => new WorkspaceOperationError({ code: errorCodeOf(cause), message: String(cause) }),
		}).pipe(
			Effect.match({
				onSuccess: (value): ComputerResult<A> => ({ ok: true, value }),
				onFailure: ({ code, message }): ComputerResult<A> => ({ ok: false, code, message }),
			}),
		),
	)

/** Abort the object so it restarts empty. abort throws to unwind; the object resets either way. */
const abortQuietly = (abort: () => void) => Effect.runSync(Effect.ignore(Effect.try(abort)))

class ComputerBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
	// For withWorkspace's options, which see the instance but not `ctx` or `env`: DurableObject keeps them
	// protected.
	readonly storage = workspaceStorage(this.ctx.storage)
	readonly shell = new WorkerShellBackend({
		id: 'shell' satisfies Backend,
		loader: this.env.LOADER,
		workspace: { binding: COMPUTER_BINDING, id: this.ctx.id.toString() },
		ctx: this.ctx,
		commands: [jq],
	})
	readonly container = new CloudflareContainerBackend({
		id: 'container' satisfies Backend,
		container: () => containerHost(this),
		workspace: { binding: COMPUTER_BINDING, id: this.ctx.id.toString() },
		// Commands may install packages.
		egress: { mode: 'direct' },
	})
}

export class Computer extends withWorkspace(ComputerBase, (self) => ({
	storage: self.storage,
	git: createGitClient(),
	backends: [self.shell, self.container],
})) {
	/** The container's connection, which `computerd` dials in through WorkspaceProxy. */
	override async fetch(request: Request): Promise<Response> {
		return await this.container.handleFetch(request)
	}

	/**
	 * Start the container and connect to it, so the first container command doesn't wait for it. Runs a
	 * no-op command: the workspace connects a backend on its first command.
	 */
	async startContainer(): Promise<ComputerResult<null>> {
		return await this.exec({
			backend: 'container',
			command: 'true',
			cwd: '/',
			timeoutMs: CONTAINER_START_TIMEOUT_MILLIS,
		}).then((result) => (result.ok ? { ok: true, value: null } : result))
	}

	/**
	 * Clone each repo into `/workspace/<name>`, one at a time, replacing whatever a cut-off earlier attempt
	 * left there. Rejects with the first repo that fails.
	 */
	async prepare(repos: ReadonlyArray<RepoSpec>): Promise<ReadonlyArray<ClonedRepo>> {
		using workspace = await getWorkspace(this)
		const git: GitClient = workspace.git
		await workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true })

		const cloned: Array<ClonedRepo> = []
		const clone = async (repo: RepoSpec): Promise<ClonedRepo> => {
			const dir = `${WORKSPACE_ROOT}/${repo.name}`
			await workspace.fs.rm(dir, { recursive: true, force: true })
			const options: GitCloneOptions = { url: repo.url, dir }
			if (repo.ref !== null) options.ref = repo.ref
			await git.clone(options)
			return { ...repo, dir, commit: await git.revParse({ dir, ref: 'HEAD' }) }
		}
		for (const repo of repos) {
			cloned.push(
				await clone(repo).catch((cause: unknown) => {
					throw new Error(`Cloning ${repo.name} from ${repo.url} failed: ${String(cause)}`, { cause })
				}),
			)
		}
		return cloned
	}

	// The file methods fold's read, write, edit and apply_patch tools and its skill loader need. Paths are
	// absolute.

	async readFile(path: string): Promise<ComputerResult<Uint8Array>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => new Response(await workspace.fs.readFile(path)).bytes())
	}

	async writeFile(path: string, content: string): Promise<ComputerResult<null>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => {
			await workspace.fs.writeFile(path, content)
			return null
		})
	}

	async mkdir(path: string, recursive: boolean): Promise<ComputerResult<null>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => {
			await workspace.fs.mkdir(path, { recursive })
			return null
		})
	}

	async rm(path: string, recursive: boolean, force: boolean): Promise<ComputerResult<null>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => {
			await workspace.fs.rm(path, { recursive, force })
			return null
		})
	}

	/** Follows symlinks. */
	async stat(path: string): Promise<ComputerResult<FileInfo>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => {
			const stat = await workspace.fs.stat(path)
			const type = stat.isDirectory ? 'Directory' : stat.isSymbolicLink ? 'SymbolicLink' : 'File'
			return { type, size: stat.size, mtime: stat.mtime, mode: stat.mode, inode: stat.inode }
		})
	}

	/**
	 * Delete this workspace at `deleteAt` (epoch milliseconds) unless moved again before then. Its session
	 * normally deletes it first; this is the backup for one that never does, such as a failed first clone.
	 */
	async expireAt(deleteAt: number): Promise<void> {
		await this.ctx.storage.setAlarm(deleteAt)
	}

	/** Delete the workspace: the container, files, git data, and the backup alarm. The object then restarts empty. */
	async destroy(): Promise<void> {
		if (this.ctx.container?.running === true) await this.ctx.container.destroy('workspace deleted')
		await this.ctx.storage.deleteAlarm()
		await this.ctx.storage.deleteAll()
		// The in-memory workspace must go: its tables are gone. Wait until this call has answered: Cloudflare
		// holds the answer until the delete is saved, and an abort before then fails the call.
		setTimeout(() => abortQuietly(() => this.ctx.abort('workspace deleted')), RESTART_DELAY_MILLIS)
	}

	/** Only `expireAt` sets the alarm, and each call replaces it, so it fires at the latest deadline. */
	override async alarm(): Promise<void> {
		await this.destroy()
	}

	/** Run one command. A command that fails still succeeds here, with its exit code. */
	async exec(input: CommandInput): Promise<ComputerResult<CommandOutput>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => {
			using handle = await workspace.runtime.exec(input.command, {
				backend: input.backend,
				cwd: input.cwd,
				encoding: 'utf8',
				timeoutMs: input.timeoutMs,
			})
			const { status, exitCode, stdout, stderr } = await handle.result()
			return { status, exitCode, stdout, stderr }
		})
	}

	/** The directory's entry names. */
	async readdir(path: string): Promise<ComputerResult<ReadonlyArray<string>>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => (await workspace.fs.readdir(path)).map((entry) => entry.name))
	}
}

export default {
	fetch: () => new Response('Not found', { status: 404 }),
} satisfies ExportedHandler
