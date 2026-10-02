import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import { Effect } from 'effect'

import { ComputerWorker } from './src/computer/ComputerWorker'
import Worker from './src/Worker'

export default Alchemy.Stack(
	'FoldAlchemyCloudflare',
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.gen(function* () {
		// First: ChatWorker binds the Computer Durable Object by this Worker's script name.
		yield* ComputerWorker
		const worker = yield* Worker
		return { url: worker.url }
	}),
)
