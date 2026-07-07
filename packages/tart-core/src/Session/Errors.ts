/**
 * This file defines the tagged errors surfaced by the Session facade: sending before the session has
 * started, and starting a session that is already running. Both are caller-repairable precondition
 * failures, so they live in the service error channel rather than dying as defects.
 */
import { Schema } from 'effect'

import { SessionId } from '../Ids'

/** Raised when `Session.send` is called before `Session.start`. */
export class SessionNotStartedError extends Schema.TaggedErrorClass<SessionNotStartedError>()(
	'SessionNotStartedError',
	{
		message: Schema.String,
	},
) {}

/** Raised when `Session.start` is called on a session that has already been started. */
export class SessionAlreadyStartedError extends Schema.TaggedErrorClass<SessionAlreadyStartedError>()(
	'SessionAlreadyStartedError',
	{
		message: Schema.String,
		sessionId: SessionId,
	},
) {}
