import { defineRule, type ESTree } from '@oxlint/plugins'

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function

const isRuntimeFunction = (node: ESTree.Node): node is RuntimeFunction =>
	node.type === 'ArrowFunctionExpression' ||
	node.type === 'FunctionDeclaration' ||
	node.type === 'FunctionExpression'

const isInsideTypeGuard = (node: ESTree.Node): boolean => {
	let current: ESTree.Node | null = node.parent
	while (current !== null && current.type !== 'Program') {
		if (isRuntimeFunction(current)) return current.returnType?.typeAnnotation.type === 'TSTypePredicate'
		current = current.parent
	}
	return false
}

export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow runtime typeof checks; external values must be decoded at their I/O boundary.',
		},
		messages: {
			runtimeTypeof:
				'A `typeof` check narrows a representation without establishing its contract. Decode input at its I/O boundary, then use Predicate, Match, or typed Effect error handling.',
		},
		schema: [
			{
				type: 'object',
				properties: { allowInTypeGuards: { type: 'boolean' } },
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const option = context.options?.[0]
				const allowInTypeGuards =
					typeof option === 'object' &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true
				if (node.operator === 'typeof' && (!allowInTypeGuards || !isInsideTypeGuard(node))) {
					context.report({ node, messageId: 'runtimeTypeof' })
				}
			},
		}
	},
})
