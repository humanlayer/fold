import { defineRule } from '@oxlint/plugins'

// Vendored from typeonce-dev/ai-automation (rules/oxlint/src/rules/prefer-option-from-nullable.ts).
// Adapted to Fold's defineRule/messageId convention.

type Node = {
	readonly type: string
	readonly [key: string]: unknown
}

const isNode = (value: unknown): value is Node =>
	typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

const isNullLiteral = (node: unknown): boolean => isNode(node) && node.type === 'Literal' && node.value === null

const isOptionMemberCall = (name: string, node: unknown): boolean => {
	if (!isNode(node) || node.type !== 'CallExpression') return false

	const callee = node.callee
	const member =
		isNode(callee) && callee.type === 'MemberExpression'
			? callee
			: isNode(callee) && callee.type === 'TSInstantiationExpression' && isNode(callee.expression)
				? callee.expression
				: undefined

	return (
		isNode(member) &&
		member.type === 'MemberExpression' &&
		isNode(member.object) &&
		member.object.type === 'Identifier' &&
		member.object.name === 'Option' &&
		isNode(member.property) &&
		member.property.type === 'Identifier' &&
		member.property.name === name
	)
}

export default defineRule({
	meta: {
		type: 'problem',
		docs: {
			description:
				'Use Option.fromNullable instead of ternaries that choose between Option.some and Option.none.',
		},
		messages: {
			preferFromNullable:
				'Use Option.fromNullable instead of a nullable ternary with Option.some and Option.none.',
		},
	},
	createOnce(context) {
		return {
			ConditionalExpression(node) {
				if (
					node.test.type !== 'BinaryExpression' ||
					(node.test.operator !== '!==' && node.test.operator !== '!=') ||
					(!isNullLiteral(node.test.left) && !isNullLiteral(node.test.right))
				) {
					return
				}

				if (isOptionMemberCall('some', node.consequent) && isOptionMemberCall('none', node.alternate)) {
					context.report({ node, messageId: 'preferFromNullable' })
				}
			},
		}
	},
})
