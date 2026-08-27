import { defineRule } from '@oxlint/plugins'

export default defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Use tagged constructors instead of manually defining `_tag` in object literals.',
		},
		messages: {
			manualConstruction:
				'Do not define a literal `_tag` manually. Use Schema tagged `.make`, a tagged class/error constructor, or a Data.taggedEnum constructor.',
		},
	},
	createOnce(context) {
		return {
			ObjectExpression(node) {
				for (const property of node.properties) {
					if (property.type !== 'Property' || property.kind !== 'init') continue
					const isTag =
						(!property.computed && property.key.type === 'Identifier' && property.key.name === '_tag') ||
						(property.key.type === 'Literal' && property.key.value === '_tag')
					if (!isTag) continue
					const valueText = context.sourceCode.getText(property.value)
					if (!/^(?:['"][^'"]+['"]|`[^`]+`)(?:\s+as\s+const)?$/.test(valueText)) continue
					context.report({ node: property, messageId: 'manualConstruction' })
				}
			},
		}
	},
})
