/**
 * This file implements Profiles - the session-fixed, mutable role->model bindings behind role-name
 * subagent model bindings (profiles slice; D25's roles are the profile map source). One instance per
 * session holds the map that `defineSubagent({ model: 'smart' | 'fast' | 'orchestrator' })` bindings
 * resolve through at each dispatch/resume, so `FoldSession.setProfile` swaps a provider once and every
 * profile-bound subagent follows on its very next run - no epoch machinery, because children provision
 * per dispatch/resume anyway. `orchestrator` falls back to `smart` when unbound (D25). An unbound role
 * at resolve time is an engine invariant violation - session-start validation rejects any roster whose
 * role bindings the initial profiles do not cover - and dies like other configuration invariants.
 */
import { Context, Effect, Ref, Schema } from 'effect'

import type { FoldModel } from '../Api/ModelDescriptor'

/** The roles a subagent's model binding may name: core's `ModelRole` minus `inherit` (D21/D25). */
export const ProfileRole = Schema.Literals(['orchestrator', 'smart', 'fast']).annotate({
	identifier: 'ProfileRole',
})
export type ProfileRole = typeof ProfileRole.Type

/** Narrow a `FoldModel | ProfileRole` binding: a role is a literal string, a model is an object. */
export const isProfileRole = Schema.is(ProfileRole)

/**
 * A session's role->model bindings, as passed to `startSession`/`resumeSession`. A plain type, not a
 * schema: the values are full model descriptors carrying Redacted keys and provider Effects (the same
 * status as `FoldModel` itself); nothing durable is written from this map - role bindings resolve to
 * concrete models before any log row exists.
 */
export type SessionProfiles = {
	readonly smart?: FoldModel
	readonly fast?: FoldModel
	readonly orchestrator?: FoldModel
}

/** The model covering one role in a profiles map; `orchestrator` falls back to `smart` (D25). */
export const profileModelFor = (profiles: SessionProfiles, role: ProfileRole): FoldModel | undefined =>
	role === 'orchestrator' ? (profiles.orchestrator ?? profiles.smart) : profiles[role]

/** Session-wide mutable role->model bindings; role-bound agents resolve per dispatch/resume. */
export type ProfilesService = {
	/**
	 * The model currently bound to a role (`orchestrator` falls back to `smart`, D25). Dies when the
	 * role is uncovered: session-start validation guarantees every role a registry entry names resolves
	 * against the initial bindings, and `set` can only add or replace bindings - so an unbound role
	 * here is an engine invariant violation, never a caller error.
	 */
	readonly resolve: (role: ProfileRole) => Effect.Effect<FoldModel>
	/** Rebind one role; every subsequent dispatch/resume of a role-bound type sees the new model. */
	readonly set: (role: ProfileRole, model: FoldModel) => Effect.Effect<void>
	/** Atomically replace the complete role map at a session configuration commit boundary. */
	readonly replace: (profiles: SessionProfiles) => Effect.Effect<void>
	/** The current bindings, as plain data. */
	readonly snapshot: Effect.Effect<SessionProfiles>
}

/** Profiles service tag; one instance per session, shared by the facade and the Subagents engine. */
export class Profiles extends Context.Service<Profiles, ProfilesService>()('fold/Profiles') {}

/** Build one session's profiles over the initial bindings from `startSession`/`resumeSession`. */
export const makeProfiles = (initial: SessionProfiles): Effect.Effect<ProfilesService> =>
	Effect.gen(function* () {
		const state = yield* Ref.make<SessionProfiles>(initial)

		const resolve = (role: ProfileRole): Effect.Effect<FoldModel> =>
			Ref.get(state).pipe(
				Effect.flatMap((profiles) => {
					const model = profileModelFor(profiles, role)
					return model === undefined
						? Effect.die(
								new Error(
									`profile role "${role}" has no bound model - session-start validation should have rejected this roster`,
								),
							)
						: Effect.succeed(model)
				}),
			)

		const set = (role: ProfileRole, model: FoldModel): Effect.Effect<void> =>
			Ref.update(state, (profiles) =>
				role === 'smart'
					? { ...profiles, smart: model }
					: role === 'fast'
						? { ...profiles, fast: model }
						: { ...profiles, orchestrator: model },
			)

		return { resolve, set, replace: (profiles) => Ref.set(state, profiles), snapshot: Ref.get(state) }
	})
