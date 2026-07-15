import { join } from 'node:path'

import { SessionId } from '@humanlayer/fold-core'
import { Effect, Option, Schema } from 'effect'

import { fileSystemFor } from '../Fs/DefaultFileSystem'
import { sessionsDirFor, type SessionLayoutOptions } from './SessionLayout'

const ViewedChangeRecord = Schema.Struct({
	sessionId: SessionId,
	changeKey: Schema.String,
	patchHash: Schema.String,
	ts: Schema.Number,
})

const decodeViewedChangeRecord = Schema.decodeUnknownOption(ViewedChangeRecord)

export type ViewedPatchHashes = Readonly<Record<string, string>>

const viewedChangesPath = (options?: SessionLayoutOptions): string =>
	join(sessionsDirFor(options), 'viewed-changes.jsonl')

export const loadViewedPatchHashes = (
	sessionId: SessionId,
	options?: SessionLayoutOptions,
): Effect.Effect<ViewedPatchHashes> => {
	const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
	return fs.readFileString(viewedChangesPath(options)).pipe(
		Effect.map((contents) => {
			const viewed: Record<string, string> = {}
			for (const line of contents.split('\n')) {
				if (line.trim().length === 0) continue
				try {
					const record = decodeViewedChangeRecord(JSON.parse(line))
					if (Option.isSome(record) && record.value.sessionId === sessionId) {
						viewed[record.value.changeKey] = record.value.patchHash
					}
				} catch {
					// A partial record does not invalidate the rest of this derived UI index.
				}
			}
			return viewed
		}),
		Effect.catch(() => Effect.succeed({})),
	)
}

export const saveViewedPatchHash = (
	sessionId: SessionId,
	changeKey: string,
	patchHash: string,
	options?: SessionLayoutOptions,
): Effect.Effect<void> => {
	const fs = fileSystemFor(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem })
	const directory = sessionsDirFor(options)
	const record = { sessionId, changeKey, patchHash, ts: Date.now() }
	return fs.makeDirectory(directory, { recursive: true }).pipe(
		Effect.andThen(fs.writeFileString(viewedChangesPath(options), `${JSON.stringify(record)}\n`, { flag: 'a' })),
		Effect.catch(() => Effect.void),
	)
}
