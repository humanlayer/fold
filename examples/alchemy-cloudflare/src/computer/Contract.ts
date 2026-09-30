/**
 * What both sides of the Computer boundary share: the Computer Worker's script name, where repos live, and
 * the values its RPC methods take and return. Plain values only, so the Computer bundle stays free of Effect.
 */

/**
 * The Computer Worker's script name. Fixed, so ChatWorker can bind the Computer Durable Object across
 * scripts; it also means one deploy of this stack per Cloudflare account.
 */
export const COMPUTER_WORKER_NAME = 'fold-alchemy-cloudflare-computer'

/** Every repo clones into `${WORKSPACE_ROOT}/<name>`. */
export const WORKSPACE_ROOT = '/workspace'

export type RepoSpec = {
	readonly name: string
	readonly url: string
	/** Branch, tag, or commit; the remote's default branch when null. */
	readonly ref: string | null
}

export type ClonedRepo = RepoSpec & {
	readonly dir: string
	/** The commit checked out. */
	readonly commit: string
}

/**
 * A file method's outcome. Failures come back as values, not thrown: an error thrown across RPC keeps its
 * message but loses its `code` (`ENOENT`, `EISDIR`, ...), which the file tools need.
 */
export type FileResult<A> =
	| { readonly ok: true; readonly value: A }
	| { readonly ok: false; readonly code: string; readonly message: string }

export type FileInfo = {
	readonly type: 'File' | 'Directory' | 'SymbolicLink'
	readonly size: number
	/** Milliseconds since the epoch. */
	readonly mtime: number
	readonly mode: number
	readonly inode: number
}
