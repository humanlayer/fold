import { defineRule } from '@oxlint/plugins'

const standardArrayMethods = new Set(['from', 'isArray', 'of'])

export default defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Require globalThis.Array when Array is imported from effect.',
		},
		messages: {
			shadowedArray:
				'Array is imported from effect in this file. Use globalThis.Array for standard Array static APIs.',
		},
	},
	createOnce(context) {
		let arrayImportedFromEffect = false

		return {
			ImportDeclaration(node) {
				if (
					node.source.value === 'effect' &&
					node.specifiers.some(
						(specifier) =>
							specifier.type === 'ImportSpecifier' &&
							specifier.imported.type === 'Identifier' &&
							specifier.imported.name === 'Array' &&
							specifier.local.name === 'Array',
					)
				) {
					arrayImportedFromEffect = true
				}
			},
			MemberExpression(node) {
				if (!arrayImportedFromEffect) return
				if (
					node.object.type === 'Identifier' &&
					node.object.name === 'Array' &&
					node.property.type === 'Identifier' &&
					standardArrayMethods.has(node.property.name)
				) {
					context.report({ node, messageId: 'shadowedArray' })
				}
			},
		}
	},
})
