/**
 * This file defines the SkillSource service (D20) - the isomorphic seam skills load through: `list`
 * returns the metadata roster, `load` returns full content (progressive disclosure). Core ships the
 * from-data implementation for hosts that pass skills in (browser/workers/presets); tart-fs ships the
 * disk loader. Public configuration goes through descriptors ({@link skillsFromData} /
 * {@link skillSource}) so no service or layer appears in caller signatures.
 */
import { Context, Effect, Schema } from 'effect'

import { skillDescriptionProblem, skillNameProblem, type Skill, type SkillMeta } from './Schemas'

/** The requested skill is not in the source. Carries the roster so the model can self-correct. */
export class SkillNotFoundError extends Schema.TaggedErrorClass<SkillNotFoundError>()('SkillNotFoundError', {
	name: Schema.String,
	availableSkills: Schema.Array(Schema.String),
}) {}

/** The skill source itself failed (disk unreadable, malformed data, ...). */
export class SkillSourceError extends Schema.TaggedErrorClass<SkillSourceError>()('SkillSourceError', {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

/** Skill discovery and loading. `list` is re-run by the skill tool's refresh path. */
export type SkillSourceService = {
	readonly list: Effect.Effect<ReadonlyArray<SkillMeta>, SkillSourceError>
	readonly load: (name: string) => Effect.Effect<Skill, SkillNotFoundError | SkillSourceError>
}

/** SkillSource service tag for advanced/low-level composition. */
export class SkillSource extends Context.Service<SkillSource, SkillSourceService>()('tart/SkillSource') {}

/** Input for one data-backed skill. `baseDir` is for hosts mirroring on-disk skills. */
export type SkillData = {
	readonly name: string
	readonly description: string
	readonly content: string
	readonly baseDir?: string
}

/**
 * Build a SkillSource from in-memory data. Invalid names/descriptions are defects: data-backed skills
 * are host code, not user content, so a spec violation is a programming error.
 */
export const skillSourceFromData = (skills: ReadonlyArray<SkillData>): Effect.Effect<SkillSourceService> =>
	Effect.gen(function* () {
		const byName = new Map<string, Skill>()

		for (const skill of skills) {
			const problem = skillNameProblem(skill.name) ?? skillDescriptionProblem(skill.description)
			if (problem !== null) {
				return yield* Effect.die(new Error(`invalid skill "${skill.name}": ${problem}`))
			}
			if (byName.has(skill.name)) {
				return yield* Effect.die(new Error(`duplicate skill name: ${skill.name}`))
			}
			byName.set(skill.name, {
				name: skill.name,
				description: skill.description,
				content: skill.content,
				baseDir: skill.baseDir ?? null,
			})
		}

		const metas: ReadonlyArray<SkillMeta> = [...byName.values()].map(({ name, description }) => ({
			name,
			description,
		}))

		return {
			list: Effect.succeed(metas),
			load: (name: string) => {
				const skill = byName.get(name)
				return skill === undefined
					? Effect.fail(new SkillNotFoundError({ name, availableSkills: metas.map((meta) => meta.name) }))
					: Effect.succeed(skill)
			},
		}
	})

/** Skills configuration descriptor for {@link defineAgent}: data-backed or a custom source seam. */
export type TartSkills =
	| { readonly _tag: 'fromData'; readonly skills: ReadonlyArray<SkillData> }
	| { readonly _tag: 'source'; readonly make: Effect.Effect<SkillSourceService, unknown> }

/** Configure an agent's skills from in-memory data (isomorphic; browser/worker hosts). */
export const skillsFromData = (skills: ReadonlyArray<SkillData>): TartSkills => ({ _tag: 'fromData', skills })

/**
 * Configure an agent's skills from a custom source implementation (the extension seam, mirroring
 * `eventLogSource`): tart-fs exposes its disk loader through this.
 */
export const skillSource = (make: Effect.Effect<SkillSourceService, unknown>): TartSkills => ({
	_tag: 'source',
	make,
})

/** Lower a skills descriptor to its source implementation (composition-root internal). */
export const skillSourceFor = (skills: TartSkills): Effect.Effect<SkillSourceService> =>
	skills._tag === 'fromData' ? skillSourceFromData(skills.skills) : skills.make.pipe(Effect.orDie)
