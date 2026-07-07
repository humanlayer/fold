/**
 * This file builds the skill tool and the system-prompt skills block (D20). The roster is read ONCE at
 * session start and baked into both the leading system prompt and the tool description - never
 * re-listed per request, so adding a skill mid-session cannot invalidate the provider prompt cache.
 * New skills become discoverable through the tool's `refresh` flag, which diffs the live list against
 * the session-start snapshot and reports changes inside the tool result (cache-neutral).
 */
import { Effect } from 'effect'

import { defineTool, type TartTool } from '../Api/ToolDefinition'
import { skillToolContract } from '../Tools/Contracts'
import type { SkillMeta } from './Schemas'
import type { SkillSourceService } from './SkillSource'

/** Escape text destined for the XML-ish skills listing (pi parity). */
const escapeXml = (text: string): string =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')

/** Render the metadata roster for prompts and refresh reports. */
const renderSkillList = (skills: ReadonlyArray<SkillMeta>): string =>
	skills
		.map(
			(skill) =>
				`  <skill>\n    <name>${escapeXml(skill.name)}</name>\n    <description>${escapeXml(skill.description)}</description>\n  </skill>`,
		)
		.join('\n')

/**
 * Render the system-prompt skills block for one roster snapshot (D17/D20). Returns null when the
 * roster is empty so no block is written.
 */
export const renderSkillsBlock = (skills: ReadonlyArray<SkillMeta>): string | null => {
	if (skills.length === 0) return null

	return (
		'The following skills provide specialized instructions and workflows for specific tasks.\n' +
		"Use the skill tool to load a skill when the task matches its description, then follow the skill's instructions.\n" +
		'\n' +
		`<available_skills>\n${renderSkillList(skills)}\n</available_skills>`
	)
}

/** Wrap loaded skill content for the model (agentlayer-parity wrapper; content is inert text). */
export const renderSkillContent = (skill: {
	readonly name: string
	readonly content: string
	readonly baseDir: string | null
}): string => {
	const baseDirAttribute = skill.baseDir === null ? '' : ` baseDir="${escapeXml(skill.baseDir)}"`
	const baseDirNote =
		skill.baseDir === null
			? ''
			: `Relative paths referenced by this skill (references/, scripts/, ...) resolve against ${skill.baseDir}.\n\n`

	return `<skill name="${escapeXml(skill.name)}"${baseDirAttribute}>\n${baseDirNote}${skill.content.trim()}\n</skill>`
}

/** Input for {@link makeSkillTool}: the resolved source and the session-start roster snapshot. */
export type MakeSkillToolInput = {
	readonly source: SkillSourceService
	/** Roster read once at session start; the tool description and refresh diffs bake against it. */
	readonly snapshot: ReadonlyArray<SkillMeta>
}

/**
 * Build the skill tool over a resolved source (D20). The description advertises the session-start
 * roster (names only - full descriptions live in the system prompt block); `refresh` re-runs `list`
 * and reports additions/removals without touching any cached prompt bytes.
 */
export const makeSkillTool = (input: MakeSkillToolInput): TartTool => {
	const snapshotNames = input.snapshot.map((meta) => meta.name)
	const rosterSuffix =
		snapshotNames.length === 0
			? ' No skills were available when this session started; call with refresh: true to re-scan.'
			: ` Available skills: ${snapshotNames.join(', ')}.`

	return defineTool({
		...skillToolContract,
		description: `${skillToolContract.description}${rosterSuffix}`,
		handler: (params) =>
			Effect.gen(function* () {
				const refreshReport = params.refresh === true ? yield* refreshedRoster(input) : null

				const skill = yield* input.source.load(params.name).pipe(
					Effect.mapError((error) =>
						error._tag === 'SkillNotFoundError'
							? {
									message: `Skill "${params.name}" not found. Available skills: ${
										error.availableSkills.length === 0 ? '(none)' : error.availableSkills.join(', ')
									}`,
									availableSkills: error.availableSkills,
								}
							: { message: `Skill source failed: ${error.message}`, availableSkills: snapshotNames },
					),
				)

				const content = renderSkillContent(skill)
				return { content: refreshReport === null ? content : `${content}\n\n${refreshReport}` }
			}),
	})
}

/** Re-run list() and describe how the roster changed since the session-start snapshot. */
const refreshedRoster = (input: MakeSkillToolInput) =>
	Effect.gen(function* () {
		const current = yield* input.source.list.pipe(
			Effect.catchTag('SkillSourceError', (error) =>
				Effect.succeed<ReadonlyArray<SkillMeta>>([]).pipe(
					Effect.tap(Effect.logWarning(`skill refresh failed: ${error.message}`)),
				),
			),
		)
		const snapshotNames = new Set(input.snapshot.map((meta) => meta.name))
		const currentNames = new Set(current.map((meta) => meta.name))
		const added = current.filter((meta) => !snapshotNames.has(meta.name))
		const removed = input.snapshot.filter((meta) => !currentNames.has(meta.name))

		if (added.length === 0 && removed.length === 0) {
			return '<system-information>The skill list has not changed since this session started.</system-information>'
		}

		const addedLines = added.map((meta) => `- ${meta.name}: ${meta.description}`)
		const removedLines = removed.map((meta) => `- ${meta.name}`)
		const sections = [
			...(addedLines.length === 0 ? [] : [`Skills added since session start:\n${addedLines.join('\n')}`]),
			...(removedLines.length === 0 ? [] : [`Skills removed since session start:\n${removedLines.join('\n')}`]),
		]

		return `<system-information>\n${sections.join('\n\n')}\n</system-information>`
	})
