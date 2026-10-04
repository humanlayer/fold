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
		compatibility: { flags: ['nodejs_compat'], date: '2026-08-31' },
	},
	Effect.gen(function* () {
		return { fetch: yield* HttpRouter.toHttpEffect(ChatRoutes) }
	}).pipe(Effect.provide(ChatSessions.layer)),
)
