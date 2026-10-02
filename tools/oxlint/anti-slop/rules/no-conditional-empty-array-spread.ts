import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

function unwrapParentheses(node: ESTree.Expression): ESTree.Expression {
	let current = node
	while (current.type === 'ParenthesizedExpression') {
		current = current.expression
	}
	return current
}

function isEmptyArrayExpression(node: ESTree.Expression): boolean {
	return node.type === 'ArrayExpression' && node.elements.length === 0
}

function isConditionalEmptyArraySpread(node: ESTree.Expression): boolean {
	const conditional = unwrapParentheses(node)
	return (
		conditional.type === 'ConditionalExpression' &&
		(isEmptyArrayExpression(conditional.consequent) || isEmptyArrayExpression(conditional.alternate))
	)
}

export const noConditionalEmptyArraySpreadRule = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow array spreads that conditionally spread an empty array to omit items.',
		},
		messages: {
			avoid: 'This conditional spread hides item omission behind an empty array. Build the array in separate statements and add the item only when present.',
		},
	},
	createOnce(context) {
		return {
			SpreadElement(node) {
				if (node.parent.type !== 'ArrayExpression') return
				if (isConditionalEmptyArraySpread(node.argument)) {
					context.report({ node, messageId: 'avoid' })
				}
			},
		}
	},
})
