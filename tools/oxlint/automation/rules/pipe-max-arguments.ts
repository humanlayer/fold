import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const maxPipeArguments = 20

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Limit pipe calls to 20 arguments; split longer pipelines into named steps.',
		},
	},
	create(context) {
		return {
			CallExpression(node) {
				if (
					node.callee.type === 'MemberExpression' &&
					node.callee.property.type === 'Identifier' &&
					node.callee.property.name === 'pipe' &&
					node.arguments.length > maxPipeArguments
				) {
					context.report({
						node,
						message: 'This pipe has too many arguments. Split it into smaller named steps.',
					})
				}
			},
		}
	},
}

export default rule
