// Vendored from https://github.com/K-Mistele/anti-slop at cf9bad836a7ba5562f5167a3471c97a1849a9f5f
// (MIT), src/rules/no-conditional-empty-object-spread.ts.
import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

function unwrapParentheses(node: ESTree.Expression): ESTree.Expression {
	let current = node
	while (current.type === 'ParenthesizedExpression') {
		current = current.expression
	}
	return current
}

function isEmptyObjectExpression(node: ESTree.Expression): boolean {
	return node.type === 'ObjectExpression' && node.properties.length === 0
}

function isConditionalEmptyObjectSpread(node: ESTree.Expression): boolean {
	const conditional = unwrapParentheses(node)
	return (
		conditional.type === 'ConditionalExpression' &&
		(isEmptyObjectExpression(conditional.consequent) || isEmptyObjectExpression(conditional.alternate))
	)
}

/** Ban conditional empty-object spreads without changing their omission semantics. */
export const noConditionalEmptyObjectSpreadRule = defineRule({
	meta: {
		type: 'suggestion',
		docs: {
			description: 'Disallow object spreads that conditionally spread an empty object to omit fields.',
		},
		messages: {
			avoid: 'This conditional spread hides property omission behind an empty object. Build the object in separate statements and add the property only when present.',
		},
	},
	createOnce(context) {
		return {
			SpreadElement(node) {
				if (node.parent.type !== 'ObjectExpression') return
				if (isConditionalEmptyObjectSpread(node.argument)) {
					context.report({ node, messageId: 'avoid' })
				}
			},
		}
	},
})
