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
		// The Computer Durable Object with its container. Named COMPUTER_BINDING: the shell and the container
		// call back into the Computer through this binding.
		Computer: Cloudflare.Container<Computer>('Computer', {
			context: './src/computer/container',

			instanceType: 'standard-4', // standard-2 = 1 vCPU, standard-1 for 1/2 and standard-4 = 4
		}),
		LOADER: Cloudflare.WorkerLoader(),
	},
})
