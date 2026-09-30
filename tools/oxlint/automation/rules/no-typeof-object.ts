import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const isObjectLiteral = (node: { type: string; value?: unknown }) => node.type === 'Literal' && node.value === 'object'

const isTypeofExpression = (node: { type: string; operator?: string }) =>
	node.type === 'UnaryExpression' && node.operator === 'typeof'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid typeof object checks; prefer Effect Schema or explicit null and object validation.',
		},
	},
	create(context) {
		return {
			BinaryExpression(node) {
				if (
					!(
						(node.operator === '===' ||
							node.operator === '!==' ||
							node.operator === '==' ||
							node.operator === '!=') &&
						((isTypeofExpression(node.left) && isObjectLiteral(node.right)) ||
							(isObjectLiteral(node.left) && isTypeofExpression(node.right)))
					)
				) {
					return
				}

				context.report({
					node,
					message:
						'Do not compare typeof values with "object". First consider whether Effect Schema is a better solution and whether this runtime check is necessary. If it is necessary, use an explicit null and object validation helper instead.',
				})
			},
		}
	},
}

export default rule
