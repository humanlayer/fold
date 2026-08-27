import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

const equalityOperators = new Set(['==', '===', '!=', '!=='])
const broadCatchMethods = new Set(['catch', 'catchIf'])

const isTagMember = (node: ESTree.Node | null | undefined): boolean =>
	node?.type === 'MemberExpression' &&
	((!node.computed && node.property.type === 'Identifier' && node.property.name === '_tag') ||
		(node.computed && node.property.type === 'Literal' && node.property.value === '_tag'))

const isStringLiteral = (node: ESTree.Node | null | undefined): boolean =>
	node?.type === 'Literal' && typeof node.value === 'string'

const isEffectBroadCatch = (node: ESTree.Node | null | undefined): boolean =>
	node?.type === 'CallExpression' &&
	node.callee.type === 'MemberExpression' &&
	node.callee.object.type === 'Identifier' &&
	node.callee.object.name === 'Effect' &&
	node.callee.property.type === 'Identifier' &&
	broadCatchMethods.has(node.callee.property.name)

const memberRoot = (member: ESTree.MemberExpression): string | undefined => {
	if (member.object.type === 'Identifier') return member.object.name
	if (member.object.type === 'MemberExpression' && member.object.object.type === 'Identifier') {
		return member.object.object.name
	}
	return undefined
}

const isBroadCatchTagUse = (node: ESTree.Node, member: ESTree.MemberExpression): boolean => {
	let current = node.parent
	while (current !== null && current !== undefined) {
		if (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') {
			const parameter = current.params[0]
			return (
				parameter?.type === 'Identifier' &&
				memberRoot(member) === parameter.name &&
				isEffectBroadCatch(current.parent)
			)
		}
		current = current.parent
	}
	return false
}

export default defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Use Effect Match or Predicate.isTagged instead of manually inspecting `_tag`.',
		},
		messages: {
			comparison:
				'Use Predicate.isTagged for a simple tag predicate, or Match.value(...).pipe(Match.tag/Match.tags) for branching.',
			branching: 'Use Match.value(...).pipe(Match.tag/Match.tags) instead of switching on `_tag`.',
		},
	},
	createOnce(context) {
		return {
			BinaryExpression(node) {
				if (!equalityOperators.has(node.operator)) return
				const member = isTagMember(node.left) && isStringLiteral(node.right) ? node.left : node.right
				if (!isTagMember(member) || !isStringLiteral(member === node.left ? node.right : node.left)) return
				if (isBroadCatchTagUse(node, member)) return
				context.report({ node, messageId: 'comparison' })
			},
			SwitchStatement(node) {
				if (!isTagMember(node.discriminant) || isBroadCatchTagUse(node, node.discriminant)) return
				context.report({ node, messageId: 'branching' })
			},
		}
	},
})
