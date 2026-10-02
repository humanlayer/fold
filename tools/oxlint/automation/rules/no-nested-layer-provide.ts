import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

type Node = {
	[key: string]: unknown
	type: string
}

const isNode = (value: unknown): value is Node =>
	typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

const isLayerProvide = (node: unknown) =>
	isNode(node) &&
	node.type === 'CallExpression' &&
	isNode(node.callee) &&
	node.callee.type === 'MemberExpression' &&
	isNode(node.callee.object) &&
	isNode(node.callee.property) &&
	node.callee.object.type === 'Identifier' &&
	node.callee.object.name === 'Layer' &&
	node.callee.property.type === 'Identifier' &&
	node.callee.property.name === 'provide'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid nested Layer.provide calls; extract the inner layer or use Layer.provideMerge.',
		},
	},
	create(context) {
		return {
			CallExpression(node) {
				if (!isLayerProvide(node)) {
					return
				}

				for (const argument of node.arguments) {
					if (isLayerProvide(argument)) {
						context.report({
							node: argument,
							message:
								'Avoid nested Layer.provide calls. Extract the inner layer or use Layer.provideMerge.',
						})
					}
				}
			},
		}
	},
}

export default rule
