/**
 * The Worker hosting the Computer Durable Object. An async Worker: an Effect Worker's bundle drops every
 * export but its own, and `@cloudflare/computer` needs its classes exported from the Worker module.
 */
import * as Cloudflare from 'alchemy/Cloudflare'

import type { Computer } from './Computer'
import { COMPUTER_WORKER_NAME } from './Contract'

export const ComputerWorker = Cloudflare.Worker('ComputerWorker', {
	name: COMPUTER_WORKER_NAME,
	main: './src/computer/Computer.ts',
	compatibility: { flags: ['nodejs_compat'], date: '2026-08-31' },
	env: {
		// Named COMPUTER_BINDING: the shell calls back into the Computer through this binding.
		Computer: Cloudflare.DurableObject<Computer>('Computer'),
		LOADER: Cloudflare.WorkerLoader(),
	},
})
