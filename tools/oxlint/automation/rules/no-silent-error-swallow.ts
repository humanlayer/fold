import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

const catchMethods = new Set(['catch', 'catchTag', 'catchTags', 'catchReason', 'catchReasons'])
const voidMethods = new Set(['void', 'unit'])

const isEffectMember = (node: ESTree.Node | null | undefined, names: ReadonlySet<string>): boolean =>
	node?.type === 'MemberExpression' &&
	node.object.type === 'Identifier' &&
	node.object.name === 'Effect' &&
	node.property.type === 'Identifier' &&
	names.has(node.property.name)

const returnsOnlyVoid = (node: ESTree.Node): boolean => {
	if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') return false
	if (isEffectMember(node.body, voidMethods)) return true
	if (node.body.type !== 'BlockStatement' || node.body.body.length !== 1) return false
	const statement = node.body.body[0]
	return statement?.type === 'ReturnStatement' && isEffectMember(statement.argument, voidMethods)
}

export default defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Do not silently swallow Effect errors; recover, transform, or propagate them.',
		},
		messages: {
			silentSwallow:
				'Do not silently swallow Effect errors with Effect.void or Effect.unit. Recover meaningfully, transform the error, or let it propagate.',
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (!isEffectMember(node.callee, catchMethods)) return
				for (const argument of node.arguments) {
					if (argument.type === 'SpreadElement') continue
					if (returnsOnlyVoid(argument)) context.report({ node, messageId: 'silentSwallow' })
					if (argument.type !== 'ObjectExpression') continue
					for (const property of argument.properties) {
						if (property.type === 'Property' && returnsOnlyVoid(property.value)) {
							context.report({ node, messageId: 'silentSwallow' })
						}
					}
				}
			},
		}
	},
})
