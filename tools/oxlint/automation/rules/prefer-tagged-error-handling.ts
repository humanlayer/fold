import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

const equalityOperators = new Set(['==', '===', '!=', '!=='])
const broadCatchMethods = new Set(['catch', 'catchIf'])

const isTagMember = (node: ESTree.Node | null | undefined): node is ESTree.MemberExpression =>
	node?.type === 'MemberExpression' &&
	((!node.computed && node.property.type === 'Identifier' && node.property.name === '_tag') ||
		(node.computed && node.property.type === 'Literal' && node.property.value === '_tag'))

const isStringLiteral = (node: ESTree.Node | null | undefined): boolean =>
	node?.type === 'Literal' && typeof node.value === 'string'

const tagComparison = (node: ESTree.Node): ESTree.MemberExpression | undefined => {
	if (node.type !== 'BinaryExpression' || !equalityOperators.has(node.operator)) return undefined
	if (isTagMember(node.left) && isStringLiteral(node.right)) return node.left
	if (isStringLiteral(node.left) && isTagMember(node.right)) return node.right
	return undefined
}

const containsTagComparison = (root: ESTree.Node, candidate: ESTree.Node): ESTree.MemberExpression | undefined => {
	const comparison = tagComparison(candidate)
	if (comparison === undefined) return undefined
	let current: ESTree.Node | null | undefined = candidate
	while (current !== null && current !== undefined && current !== root) current = current.parent
	return current === root ? comparison : undefined
}

const isEffectBroadCatch = (node: ESTree.CallExpression): boolean =>
	node.callee.type === 'MemberExpression' &&
	node.callee.object.type === 'Identifier' &&
	node.callee.object.name === 'Effect' &&
	node.callee.property.type === 'Identifier' &&
	broadCatchMethods.has(node.callee.property.name)

const isNestedReasonTag = (member: ESTree.MemberExpression): boolean =>
	member.object.type === 'MemberExpression' &&
	!member.object.computed &&
	member.object.property.type === 'Identifier' &&
	member.object.property.name === 'reason'

const memberRoot = (member: ESTree.MemberExpression): string | undefined => {
	if (member.object.type === 'Identifier') return member.object.name
	if (member.object.type === 'MemberExpression' && member.object.object.type === 'Identifier') {
		return member.object.object.name
	}
	return undefined
}

export default defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Use Effect tagged error handlers instead of manually inspecting `_tag` in broad handlers.',
		},
		messages: {
			taggedError: 'Use Effect.catchTag or Effect.catchTags instead of manually checking an error `_tag`.',
			taggedReason:
				'Use Effect.catchReason or Effect.catchReasons instead of manually checking a tagged error reason.',
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (!isEffectBroadCatch(node)) return
				for (const argument of node.arguments) {
					if (argument.type !== 'ArrowFunctionExpression' && argument.type !== 'FunctionExpression') continue
					const parameter = argument.params[0]
					if (parameter?.type !== 'Identifier') continue
					const body = argument.body
					const text = context.sourceCode.getText(body)
					const predicatePrefix = `Predicate.isTagged(${parameter.name}`
					if (text.includes(predicatePrefix)) {
						context.report({
							node: body,
							messageId: text.includes(`${predicatePrefix}.reason,`) ? 'taggedReason' : 'taggedError',
						})
						continue
					}
					if (!text.includes('_tag')) continue

					let found: ESTree.MemberExpression | undefined
					const stack: Array<ESTree.Node> = [body]
					while (stack.length > 0 && found === undefined) {
						const candidate = stack.pop()
						if (candidate === undefined) break
						const comparison = containsTagComparison(body, candidate)
						if (comparison !== undefined && memberRoot(comparison) === parameter.name) found = comparison
						if (found !== undefined) break
						for (const key of context.sourceCode.visitorKeys[candidate.type] ?? []) {
							const child = candidate[key]
							if (Array.isArray(child)) {
								for (const item of child)
									if (item !== null && typeof item === 'object' && 'type' in item) stack.push(item)
							} else if (child !== null && typeof child === 'object' && 'type' in child) {
								stack.push(child)
							}
						}
					}

					if (found !== undefined) {
						context.report({
							node: found,
							messageId: isNestedReasonTag(found) ? 'taggedReason' : 'taggedError',
						})
					}
				}
			},
		}
	},
})
