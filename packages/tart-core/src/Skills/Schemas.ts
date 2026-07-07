/**
 * This file defines the skill domain schemas and Agent Skills spec validation (D24, agentskills.io):
 * `name` is 1-64 lowercase alphanumerics/hyphens with no leading/trailing/consecutive hyphens;
 * `description` is required and capped at 1024. Skill content is inert text - tart never executes or
 * preprocesses anything inside it (user ruling; the spec defines no inline-command feature).
 */
import { Schema } from 'effect'

/** Spec cap on skill names (agentskills.io / skills-ref MAX_SKILL_NAME_LENGTH). */
export const maxSkillNameLength = 64

/** Spec cap on skill descriptions (agentskills.io / skills-ref MAX_DESCRIPTION_LENGTH). */
export const maxSkillDescriptionLength = 1024

/** The epoch-rendered skill listing entry (D20): what the model sees in the system prompt. */
export const SkillMeta = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
})
export type SkillMeta = typeof SkillMeta.Type

/** One loadable skill. `baseDir` is set by filesystem loaders so content can reference bundled files. */
export const Skill = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	/** The SKILL.md body (frontmatter stripped), served verbatim - never executed or preprocessed. */
	content: Schema.String,
	/** Absolute directory of the skill on disk; null for data-backed skills. */
	baseDir: Schema.NullOr(Schema.String),
})
export type Skill = typeof Skill.Type

const skillNamePattern = /^[a-z0-9-]+$/

/** Validate a skill name against the Agent Skills spec. Returns the problem, or null when valid. */
export const skillNameProblem = (name: string): string | null => {
	if (name.length === 0) return 'name must not be empty'
	if (name.length > maxSkillNameLength) return `name must be at most ${maxSkillNameLength} characters`
	if (!skillNamePattern.test(name)) return 'name must contain only lowercase letters, digits, and hyphens'
	if (name.startsWith('-') || name.endsWith('-')) return 'name must not start or end with a hyphen'
	if (name.includes('--')) return 'name must not contain consecutive hyphens'
	return null
}

/** Validate a skill description against the Agent Skills spec. Returns the problem, or null when valid. */
export const skillDescriptionProblem = (description: string): string | null => {
	if (description.trim().length === 0) return 'description is required'
	if (description.length > maxSkillDescriptionLength) {
		return `description must be at most ${maxSkillDescriptionLength} characters`
	}
	return null
}
