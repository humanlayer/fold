import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description:
				'Avoid object key checks with the in operator; refactor the check or use Predicate as a last resort.',
		},
	},
	create(context) {
		return {
			BinaryExpression(node) {
				if (node.operator !== 'in') {
					return
				}

				context.report({
					node,
					message:
						'Do not use the "in" operator to check for object keys. Fix or refactor the code so this key check is not needed. Only use Predicate as a last-resort escape hatch.',
				})
			},
		}
	},
}

export default rule
