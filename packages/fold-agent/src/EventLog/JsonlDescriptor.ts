/**
 * This file exposes the JSONL event log through the public descriptor seam: `jsonlEventLog(path)`
 * plugs straight into `startSession({ log })`, hiding the layer construction the same way the core's
 * `memoryEventLog` does. One file is one session; pointing at an existing file resumes its entries.
 */
import { eventLogSource, EventLog, type FoldEventLog } from '@humanlayer/fold-core'
import { Context, Effect, FileSystem, Layer } from 'effect'

import { layerJsonl } from './JsonlLayer'

/** Back a session's durable log with one JSONL file. Existing entries replay on start (resume). */
export const jsonlEventLog = (filePath: string): FoldEventLog =>
	eventLogSource(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const fsLayer = Layer.succeed(FileSystem.FileSystem, fs)
			const context = yield* Layer.build(layerJsonl(filePath).pipe(Layer.provide(fsLayer)))

			return Context.get(context, EventLog)
		}),
	)
