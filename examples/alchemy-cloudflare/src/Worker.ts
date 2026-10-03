/**
 * The chat Worker: {@link ChatRoutes} over {@link ChatSessions}, one ChatSession Durable Object per
 * fold session.
 */
import * as Cloudflare from 'alchemy/Cloudflare'
import { Effect } from 'effect'
import { HttpRouter } from 'effect/http'

import { ChatRoutes } from './Api'
import { ChatSessions } from './ChatSessions'

export default Cloudflare.Worker(
	'ChatWorker',
	{
		main: import.meta.url,
		// 2026-10-01: pending calls to other Durable Objects, containers and timers keep a Durable Object in
		// memory with no client connected, so a turn whose client has gone runs on.
		compatibility: { flags: ['nodejs_compat'], date: '2026-10-01' },
	},
	Effect.gen(function* () {
		return { fetch: yield* HttpRouter.toHttpEffect(ChatRoutes) }
	}).pipe(Effect.provide(ChatSessions.layer)),
)
