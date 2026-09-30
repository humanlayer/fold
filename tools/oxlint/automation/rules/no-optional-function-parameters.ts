import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

type Node = {
	[key: string]: unknown
	type: string
}

const isNode = (value: unknown): value is Node =>
	typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

const message = 'Optional function parameters are banned. Use an explicit union with undefined or null.'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid optional function parameters; use an explicit union with undefined or null.',
		},
	},
	create(context) {
		return {
			FunctionDeclaration(node) {
				for (const param of node.params) {
					if (
						isNode(param) &&
						(param.optional === true || (isNode(param.parameter) && param.parameter.optional === true))
					) {
						context.report({
							node: param,
							message,
						})
					}
				}
			},
			FunctionExpression(node) {
				for (const param of node.params) {
					if (
						isNode(param) &&
						(param.optional === true || (isNode(param.parameter) && param.parameter.optional === true))
					) {
						context.report({
							node: param,
							message,
						})
					}
				}
			},
			ArrowFunctionExpression(node) {
				for (const param of node.params) {
					if (
						isNode(param) &&
						(param.optional === true || (isNode(param.parameter) && param.parameter.optional === true))
					) {
						context.report({
							node: param,
							message,
						})
					}
				}
			},
		}
	},
}

export default rule
