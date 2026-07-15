/**
 * This file exposes the JSONL event log through the public descriptor seam: `jsonlEventLog(path)`
 * plugs straight into `startSession({ log })`, hiding the layer construction the same way the core's
 * `memoryEventLog` does. One file is one session; pointing at an existing file resumes its entries.
 */
import { eventLogSource, EventLog, type FoldEventLog } from '@humanlayer/fold-core'
import { Context, Effect, FileSystem, Layer } from 'effect'

import { fileSystemFor, type FsToolOptions } from '../Fs/DefaultFileSystem'
import { layerJsonl } from './JsonlLayer'

/** Options for {@link jsonlEventLog}: the FileSystem seam (Node default, overridable for tests). */
export type JsonlEventLogOptions = Pick<FsToolOptions, 'fileSystem'>

/** Back a session's durable log with one JSONL file. Existing entries replay on start (resume). */
export const jsonlEventLog = (filePath: string, options?: JsonlEventLogOptions): FoldEventLog =>
	eventLogSource(
		Effect.gen(function* () {
			const fsLayer = Layer.succeed(FileSystem.FileSystem, fileSystemFor(options))
			const context = yield* Layer.build(layerJsonl(filePath).pipe(Layer.provide(fsLayer)))

			return Context.get(context, EventLog)
		}),
	)
