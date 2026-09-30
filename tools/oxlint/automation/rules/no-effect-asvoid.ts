import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const message = 'Avoid Effect.asVoid. Prefer returning the effect directly when the success type is void.'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid Effect.asVoid; return effects whose success type is already void directly.',
		},
	},
	create(context) {
		return {
			MemberExpression(node) {
				if (
					node.object.type === 'Identifier' &&
					node.object.name === 'Effect' &&
					node.property.type === 'Identifier' &&
					node.property.name === 'asVoid'
				) {
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
