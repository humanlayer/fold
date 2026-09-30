import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const bannedTypes = new Set(['TSAnyKeyword', 'TSNeverKeyword', 'TSUnknownKeyword'])

const message = 'Do not assert to any, never, or unknown. Fix the type or use generics.'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Disallow assertions to any, never, or unknown; fix the type or use generics.',
		},
	},
	create(context) {
		return {
			TSAsExpression(node) {
				if (bannedTypes.has(node.typeAnnotation.type)) {
					context.report({
						node,
						message,
					})
				}
			},
			TSTypeAssertion(node) {
				if (bannedTypes.has(node.typeAnnotation.type)) {
					context.report({
						node,
						message,
					})
				}
			},
		}
	},
}

export default rule
