import { oxlintRuleMetadata, rulesByProfile, severityByRule, type RuleProfile } from './catalog.ts'

type Severity = 'error' | 'warn'

export const profile = (name: RuleProfile, namespace = 'automation'): Readonly<Record<string, Severity>> =>
	Object.fromEntries(
		rulesByProfile[name].map((ruleName) => [`${namespace}/${ruleName}`, severityByRule[ruleName] ?? 'error']),
	)

export const profiles = Object.freeze({
	architecture: profile('architecture'),
	core: profile('core'),
	effect: profile('effect'),
	nextTailwind: profile('next-tailwind'),
	react: profile('react'),
	xstate: profile('xstate'),
})

export const allRules = Object.freeze(
	Object.fromEntries(oxlintRuleMetadata.map(({ name, severity }) => [`automation/${name}`, severity])),
)
