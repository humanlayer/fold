/**
 * This file defines the isomorphic built-in tool contracts (D18): name, description, and schemas for
 * read / write / edit / apply_patch / skill, with NO handlers. Platform packages (tart-fs today;
 * browser/worker hosts later) pair these contracts with their own handlers via `defineTool`; the
 * ToolsetResolver's family policy keys off these exact names (claude-family edits through write/edit,
 * gpt/codex-family through apply_patch).
 */
import { Schema } from 'effect'

import { ToolResultContent } from './ToolResultContent'
import { defaultMaxLines, formatSize, defaultMaxBytes } from './Truncation'

/** A tool's model-facing surface without a handler: spread into `defineTool` next to one. */
export type ToolContract<
	Params extends Schema.Top = Schema.Top,
	Success extends Schema.Top = Schema.Top,
	Failure extends Schema.Top = Schema.Top,
> = {
	readonly name: string
	readonly description: string
	readonly parameters: Params
	readonly success: Success
	readonly failure: Failure
}

/** Uniform expected-failure payload for built-in tools: one instructive, model-visible message. */
export const ToolFailure = Schema.Struct({
	message: Schema.String,
})
export type ToolFailure = typeof ToolFailure.Type

// --- read -------------------------------------------------------------------------------------------

const ReadParameters = Schema.Struct({
	path: Schema.String.annotate({ description: 'Path to the file to read (relative or absolute)' }),
	offset: Schema.optional(Schema.Number).annotate({ description: 'Line number to start reading from (1-indexed)' }),
	limit: Schema.optional(Schema.Number).annotate({ description: 'Maximum number of lines to read' }),
})

/** Contract for the read tool (pi port): text head-truncated, images returned as content blocks. */
export const readToolContract = {
	name: 'read',
	description:
		`Read the contents of a file. Supports text files and images (jpeg, png, gif, webp, bmp). ` +
		`Text output is limited to ${defaultMaxLines} lines or ${formatSize(defaultMaxBytes)}; ` +
		`use offset and limit to read further sections of large files.`,
	parameters: ReadParameters,
	success: ToolResultContent,
	failure: ToolFailure,
} satisfies ToolContract<typeof ReadParameters, typeof ToolResultContent, typeof ToolFailure>

// --- write ------------------------------------------------------------------------------------------

const WriteParameters = Schema.Struct({
	path: Schema.String.annotate({ description: 'Path to the file to write (relative or absolute)' }),
	content: Schema.String.annotate({ description: 'Content to write to the file' }),
})

const WriteSuccess = Schema.Struct({
	message: Schema.String,
})

/** Contract for the write tool (pi port): full overwrite with recursive parent creation. */
export const writeToolContract = {
	name: 'write',
	description:
		"Write content to a file. Creates the file if it doesn't exist, overwrites it if it does. " +
		'Automatically creates parent directories.',
	parameters: WriteParameters,
	success: WriteSuccess,
	failure: ToolFailure,
} satisfies ToolContract<typeof WriteParameters, typeof WriteSuccess, typeof ToolFailure>

// --- edit -------------------------------------------------------------------------------------------

const EditPair = Schema.Struct({
	oldText: Schema.String.annotate({
		description:
			'Exact text for one targeted replacement. It must be unique in the original file and must not ' +
			'overlap with any other edits[].oldText in the same call.',
	}),
	newText: Schema.String.annotate({ description: 'Replacement text for this targeted edit.' }),
})

const EditParameters = Schema.Struct({
	path: Schema.String.annotate({ description: 'Path to the file to edit (relative or absolute)' }),
	edits: Schema.optional(Schema.Union([Schema.Array(EditPair), Schema.String])).annotate({
		description:
			'One or more targeted replacements. Every oldText matches against the original file content, so ' +
			'edits must target disjoint regions.',
	}),
	// Legacy single-pair form (pi compat shim): tolerated at the schema so the handler can normalize it.
	oldText: Schema.optional(Schema.String).annotate({
		description: 'Deprecated single-edit form: exact text to replace. Prefer edits[].',
	}),
	newText: Schema.optional(Schema.String).annotate({
		description: 'Deprecated single-edit form: replacement text. Prefer edits[].',
	}),
})

const EditSuccess = Schema.Struct({
	message: Schema.String,
})

/** Contract for the edit tool (pi port): batch exact-match replacements with normalization fallback. */
export const editToolContract = {
	name: 'edit',
	description:
		'Make targeted text replacements in an existing file. Each oldText must match the file content ' +
		'exactly (including whitespace and newlines) and must be unique in the file; provide more ' +
		'surrounding context to disambiguate. All edits apply against the original content in one atomic ' +
		'operation.',
	parameters: EditParameters,
	success: EditSuccess,
	failure: ToolFailure,
} satisfies ToolContract<typeof EditParameters, typeof EditSuccess, typeof ToolFailure>

// --- apply_patch ------------------------------------------------------------------------------------

const ApplyPatchParameters = Schema.Struct({
	patch_text: Schema.String.annotate({ description: 'The full patch text to apply.' }),
})

const ApplyPatchSuccess = Schema.Struct({
	message: Schema.String,
})

const applyPatchDescription = `Apply a patch to create, update, delete, or move files.

The patch must use this format:

*** Begin Patch
*** Update File: path/to/file.py
@@ class BaseClass
@@     def search():
-        pass
+        raise NotImplementedError()
*** End Patch

Within the *** Begin Patch / *** End Patch envelope, describe each file operation with a header line:
*** Add File: <path> - create a new file. Every following line is its content, each prefixed with +.
*** Update File: <path> - edit an existing file with one or more @@ hunks of context ( ), removed (-),
and added (+) lines. Optionally follow the header with *** Move to: <new path> to rename the file.
*** Delete File: <path> - remove a file.

Rules:
- Begin every patch with *** Begin Patch and end it with *** End Patch.
- Include a file header (*** Add File: / *** Update File: / *** Delete File:) before its hunks.
- Prefix every line inside a hunk with +, -, or a space; prefix every line of a new file with +.
- Use @@ lines carrying enclosing context (a class or function name) to locate ambiguous hunks.
- Keep hunks minimal: a few lines of surrounding context are enough to anchor each change.

Raw git diffs and unified diffs (diff --git, --- / +++ headers, @@ hunk headers, /dev/null for
add/delete, rename from/to) are also accepted.`

/** Contract for apply_patch (codex-family editing per D17): V4A plus raw git/unified diffs. */
export const applyPatchToolContract = {
	name: 'apply_patch',
	description: applyPatchDescription,
	parameters: ApplyPatchParameters,
	success: ApplyPatchSuccess,
	failure: ToolFailure,
} satisfies ToolContract<typeof ApplyPatchParameters, typeof ApplyPatchSuccess, typeof ToolFailure>

// --- skill ------------------------------------------------------------------------------------------

const SkillParameters = Schema.Struct({
	name: Schema.String.annotate({ description: 'The name of the skill to load, from the available skills list.' }),
	refresh: Schema.optional(Schema.Boolean).annotate({
		description: 'Also re-scan the skill source and report skills added since the session started.',
	}),
})

const SkillSuccess = Schema.Struct({
	content: Schema.String,
})

const SkillFailure = Schema.Struct({
	message: Schema.String,
	availableSkills: Schema.Array(Schema.String),
})

/** Contract for the skill tool (D20): progressive disclosure of skill content by name. */
export const skillToolContract = {
	name: 'skill',
	description:
		'Load a skill by name. Skills provide specialized instructions and workflows for specific tasks; ' +
		'the available skills are listed in the system prompt. Load a skill when the task matches its ' +
		'description, then follow its instructions.',
	parameters: SkillParameters,
	success: SkillSuccess,
	failure: SkillFailure,
} satisfies ToolContract<typeof SkillParameters, typeof SkillSuccess, typeof SkillFailure>

/**
 * The isomorphic built-in toolkit: every core tool contract, without handlers (D18). Platform packages
 * bind handlers with `defineTool({ ...contract, handler })`; hosts on other substrates (browser,
 * workers) provide their own.
 */
export const builtinToolContracts = {
	read: readToolContract,
	write: writeToolContract,
	edit: editToolContract,
	apply_patch: applyPatchToolContract,
	skill: skillToolContract,
} as const
