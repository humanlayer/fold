import { defineRule } from '@oxlint/plugins'
import type { ESTree } from '@oxlint/plugins'

// Vendored and adapted from typeonce-dev/ai-automation (rules/oxlint/src/rules/no-ambient-nondeterminism.ts).
// Adaptations: dropped the upstream's `.tsx` allow-list option (TUI/theme and tests are excluded through
// `.oxlintrc.jsonc` overrides instead) and mapped the inline messages onto `messageId`s. The scope analysis
// is preserved on purpose: it is what lets a local binding such as `const crypto = yield* Crypto.Crypto` pass
// while still catching the ambient `crypto` / `Date` / `Math` globals.

const memberPropertyName = (node: ESTree.MemberExpression): string | undefined =>
	node.property.type === 'Identifier'
		? node.property.name
		: node.property.type === 'Literal' && typeof node.property.value === 'string'
			? node.property.value
			: undefined

export default defineRule({
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow ambient randomness and time in favor of Effect Clock, Random, and Crypto capabilities.',
		},
		messages: {
			ambientDate: 'Do not read the current time from ambient Date. Use Effect Clock or DateTime capabilities.',
			ambientCrypto: "Do not use ambient crypto. Use Effect's Crypto capability instead.",
			ambientMathRandom: "Do not use ambient Math.random. Use Effect's Random capability instead.",
		},
	},
	createOnce(context) {
		const isGlobalIdentifier = (name: string, node: ESTree.Identifier): boolean => {
			if (node.name !== name) return false
			let scope: ReturnType<typeof context.sourceCode.getScope> | null = context.sourceCode.getScope(node)
			while (scope !== null) {
				const variable = scope.set.get(name)
				if (variable !== undefined) return variable.defs.length === 0
				scope = scope.upper
			}
			return true
		}

		const isGlobalThisMember = (name: string, node: ESTree.MemberExpression): boolean =>
			node.object.type === 'Identifier' &&
			isGlobalIdentifier('globalThis', node.object) &&
			memberPropertyName(node) === name

		const isGlobalObject = (name: string, node: ESTree.Node): boolean =>
			(node.type === 'Identifier' && isGlobalIdentifier(name, node)) ||
			(node.type === 'MemberExpression' && isGlobalThisMember(name, node))

		return {
			CallExpression(node) {
				if (
					node.arguments.length !== 0 ||
					node.callee.type !== 'Identifier' ||
					!isGlobalIdentifier('Date', node.callee)
				) {
					return
				}
				context.report({ node, messageId: 'ambientDate' })
			},
			Identifier(node) {
				if (
					node.parent?.type === 'MemberExpression' &&
					node.parent.property === node &&
					node.parent.computed !== true
				) {
					return
				}
				if (!isGlobalIdentifier('crypto', node)) return
				context.report({ node, messageId: 'ambientCrypto' })
			},
			MemberExpression(node) {
				if (isGlobalThisMember('crypto', node)) {
					context.report({ node, messageId: 'ambientCrypto' })
					return
				}
				const propertyName = memberPropertyName(node)
				if (propertyName === 'random' && isGlobalObject('Math', node.object)) {
					context.report({ node, messageId: 'ambientMathRandom' })
					return
				}
				if (propertyName === 'now' && isGlobalObject('Date', node.object)) {
					context.report({ node, messageId: 'ambientDate' })
				}
			},
			NewExpression(node) {
				if (
					node.arguments.length !== 0 ||
					node.callee.type !== 'Identifier' ||
					!isGlobalIdentifier('Date', node.callee)
				) {
					return
				}
				context.report({ node, messageId: 'ambientDate' })
			},
		}
	},
})
