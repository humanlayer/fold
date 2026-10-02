export type RuleProfile = 'architecture' | 'core' | 'effect' | 'next-tailwind' | 'react' | 'xstate'

export type RuleSeverity = 'error' | 'warn'

export interface OxlintRuleMetadata {
	readonly name: string
	readonly profile: RuleProfile
	readonly severity: RuleSeverity
	readonly applicability: string
	readonly options: string
	readonly exceptions: string
}

const warningRules = new Set([
	'no-cascading-layer-provide',
	'no-effect-asvoid',
	'no-nested-layer-provide',
	'no-non-route-layout-files',
	'pipe-max-arguments',
	'prefer-option-from-nullable',
])

const profileRules: Readonly<Record<RuleProfile, ReadonlyArray<string>>> = {
	architecture: [
		'no-api-backend-imports',
		'no-api-repository-imports',
		'no-comments',
		'no-reexport-only-modules',
		'no-sql-type-parameter',
		'require-tsx-in-ui-folders',
	],
	core: [
		'no-banned-type-assertions',
		'no-multiple-function-params',
		'no-optional-function-parameters',
		'no-single-use-private-functions',
		'no-type-assertion',
		'private-function-prefix',
	],
	effect: [
		'no-ambient-nondeterminism',
		'no-cascading-layer-provide',
		'no-direct-browser-storage',
		'no-direct-fetch',
		'no-disable-validation',
		'no-effect-asvoid',
		'no-global-json',
		'no-in-operator',
		'no-nested-effect-array-methods',
		'no-nested-layer-provide',
		'no-service-option',
		'no-shadowed-standard-array-static',
		'no-silent-error-swallow',
		'no-static-effect-service-forwarders',
		'no-switch',
		'no-try-catch',
		'no-typeof-object',
		'pipe-max-arguments',
		'prefer-effect-match',
		'prefer-option-from-nullable',
		'require-context-service-in-services',
	],
	'next-tailwind': [
		'no-css-modules',
		'no-fixed-height-on-content',
		'no-jsx-style',
		'no-non-route-layout-files',
		'require-approved-ui-primitives',
		'require-cn-for-classname-composition',
		'require-default-component-export',
	],
	react: ['no-react-component-inner-functions', 'no-react-non-component-function-exports', 'no-react-state-hooks'],
	xstate: [
		'no-direct-xstate-create-machine',
		'no-direct-xstate-use-selector',
		'no-multiple-xstate-hooks',
		'no-single-use-xstate-actions',
		'no-single-use-xstate-guards',
		'require-xstate-event-satisfies',
	],
}

const configurableRules: Readonly<Record<string, string>> = {
	'no-ambient-nondeterminism': 'allowedDateBasenames, allowedDateExtensions',
	'no-api-backend-imports': 'contractRootMarker, allowedImports',
	'no-api-repository-imports': 'handlerDirectoryNames, repositoryDirectoryNames, testDirectoryNames',
	'no-direct-xstate-use-selector': 'selectorModules, preferredModule',
	'no-fixed-height-on-content': 'allowedHeightUtilities, ignoredPathMarkers',
	'no-jsx-style': 'ignoredPathMarkers',
	'no-multiple-function-params': 'exemptRouteBasenames, exemptFunctionNames',
	'no-non-route-layout-files': 'routeDirectoryNames, allowedLayoutFilenames',
	'no-reexport-only-modules': 'routeDirectoryNames, allowedFilenames',
	'no-react-non-component-function-exports': 'frameworkSegmentBasenames, frameworkSpecialExports',
	'require-approved-ui-primitives': 'applicationPathMarkers, bannedElements, linkModule',
	'require-cn-for-classname-composition': 'utilityModules, utilityName, ignoredPathMarkers',
	'require-context-service-in-services': 'serviceDirectoryNames, ignoredDirectoryNames, ignoredBasenames',
	'require-default-component-export': 'applicationPathMarkers, ignoredFilenamePatterns, wrapperNames',
	'require-tsx-in-ui-folders': 'uiDirectoryNames, allowedTypeScriptFiles',
}

const exceptionNotes: Readonly<Record<string, string>> = {
	'no-api-repository-imports': 'Test files are excluded.',
	'no-direct-fetch': 'Use file overrides for scripts or adapters that intentionally own HTTP.',
	'no-reexport-only-modules': 'Framework-reserved route modules and explicit public entry points may need overrides.',
	'no-try-catch': 'Use a scoped override at an integration boundary that must consume throwing APIs.',
	'require-default-component-export': 'Framework-reserved metadata and route handler files are excluded.',
}

const profileApplicability: Readonly<Record<RuleProfile, string>> = {
	architecture: 'Layered application and package boundaries',
	core: 'TypeScript',
	effect: 'Effect',
	'next-tailwind': 'Next.js and Tailwind CSS',
	react: 'React',
	xstate: 'XState',
}

export const oxlintRuleMetadata: ReadonlyArray<OxlintRuleMetadata> = Object.entries(profileRules).flatMap(
	([profile, names]) =>
		names.map((name) => ({
			name,
			profile: profile as RuleProfile,
			severity: warningRules.has(name) ? 'warn' : 'error',
			applicability: profileApplicability[profile as RuleProfile],
			options: configurableRules[name] ?? 'None.',
			exceptions: exceptionNotes[name] ?? 'None.',
		})),
)

export const rulesByProfile = profileRules

export const severityByRule: Readonly<Record<string, RuleSeverity>> = Object.fromEntries(
	oxlintRuleMetadata.map(({ name, severity }) => [name, severity]),
)
