/// <reference types="@cloudflare/workers-types/experimental" />
/**
 * The Computer Durable Object: one `@cloudflare/computer` Workspace per fold session, named by its
 * SessionId. The Workspace is a virtual filesystem in the object's SQLite, with git. A plain Durable Object
 * rather than an Effect one, because `withWorkspace` must wrap the `cloudflare:workers` class.
 */
import { type DurableObjectStorageLike, getWorkspace, withWorkspace } from '@cloudflare/computer'
import { createGitClient, type GitClient, type GitCloneOptions } from '@cloudflare/computer/git'
import { DurableObject } from 'cloudflare:workers'

import { type ClonedRepo, type FileInfo, type FileResult, type RepoSpec, WORKSPACE_ROOT } from './Contract'

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

/** Run one file operation, returning a thrown workspace error as its code and message. */
const attempt = async <A>(operation: () => Promise<A>): Promise<FileResult<A>> => {
	try {
		return { ok: true, value: await operation() }
	} catch (cause) {
		const code =
			cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'UNKNOWN'
		return { ok: false, code, message: String(cause) }
	}
}

class ComputerBase extends DurableObject {
	/** For withWorkspace's options, which see the instance but not `ctx`: DurableObject keeps it protected. */
	readonly storage = workspaceStorage(this.ctx.storage)
}

export class Computer extends withWorkspace(ComputerBase, (self) => ({
	storage: self.storage,
	git: createGitClient(),
})) {
	/**
	 * Clone each repo into `/workspace/<name>`, one at a time, replacing whatever a cut-off earlier attempt
	 * left there. Rejects with the first repo that fails.
	 */
	async prepare(repos: ReadonlyArray<RepoSpec>): Promise<ReadonlyArray<ClonedRepo>> {
		using workspace = await getWorkspace(this)
		const git: GitClient = workspace.git
		await workspace.fs.mkdir(WORKSPACE_ROOT, { recursive: true })

		const cloned: Array<ClonedRepo> = []
		for (const repo of repos) {
			const dir = `${WORKSPACE_ROOT}/${repo.name}`
			try {
				await workspace.fs.rm(dir, { recursive: true, force: true })
				const options: GitCloneOptions = { url: repo.url, dir }
				if (repo.ref !== null) options.ref = repo.ref
				await git.clone(options)
				cloned.push({ ...repo, dir, commit: await git.revParse({ dir, ref: 'HEAD' }) })
			} catch (cause) {
				throw new Error(`Cloning ${repo.name} from ${repo.url} failed: ${String(cause)}`, { cause })
			}
		}
		return cloned
	}

	// The file methods fold's read, write, edit and apply_patch tools and its skill loader need. Paths are
	// absolute.

	async readFile(path: string): Promise<FileResult<Uint8Array>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => new Response(await workspace.fs.readFile(path)).bytes())
	}

	async writeFile(path: string, content: string): Promise<FileResult<null>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => {
			await workspace.fs.writeFile(path, content)
			return null
		})
	}

	async mkdir(path: string, recursive: boolean): Promise<FileResult<null>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => {
			await workspace.fs.mkdir(path, { recursive })
			return null
		})
	}

	async rm(path: string, recursive: boolean, force: boolean): Promise<FileResult<null>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => {
			await workspace.fs.rm(path, { recursive, force })
			return null
		})
	}

	/** Follows symlinks. */
	async stat(path: string): Promise<FileResult<FileInfo>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => {
			const stat = await workspace.fs.stat(path)
			const type = stat.isDirectory ? 'Directory' : stat.isSymbolicLink ? 'SymbolicLink' : 'File'
			return { type, size: stat.size, mtime: stat.mtime, mode: stat.mode, inode: stat.inode }
		})
	}

	/** The directory's entry names. */
	async readdir(path: string): Promise<FileResult<ReadonlyArray<string>>> {
		using workspace = await getWorkspace(this)
		return await attempt(async () => (await workspace.fs.readdir(path)).map((entry) => entry.name))
	}
}

export default {
	fetch: () => new Response('Not found', { status: 404 }),
} satisfies ExportedHandler
