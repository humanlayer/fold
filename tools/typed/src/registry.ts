import type { TypedRule, WorkspaceRule } from './rule.js'
import noXstateDerivedBooleanContext from './rules/no-xstate-derived-boolean-context.js'
import preferEffectArrayMatch from './rules/prefer-effect-array-match.js'
import preferTypedSchemaApis from './rules/prefer-typed-schema-apis.js'
import noSvgFiles from './workspace-rules/no-svg-files.js'

export const typedRules = {
	'no-xstate-derived-boolean-context': noXstateDerivedBooleanContext,
	'prefer-effect-array-match': preferEffectArrayMatch,
	'prefer-typed-schema-apis': preferTypedSchemaApis,
} as const satisfies Readonly<Record<string, TypedRule>>

export const workspaceRules = {
	'no-svg-files': noSvgFiles,
} as const satisfies Readonly<Record<string, WorkspaceRule>>

export const ruleNames = [...Object.keys(typedRules), ...Object.keys(workspaceRules)] as const

export type RuleName = keyof typeof typedRules | keyof typeof workspaceRules
