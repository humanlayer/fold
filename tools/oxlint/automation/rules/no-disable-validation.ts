import { defineRule } from '@oxlint/plugins'

export default defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Keep Effect Schema validation enabled; fix the data or schema instead.',
		},
		messages: {
			disabledValidation:
				'Do not use disableValidation: true. Fix the data or schema and keep validation enabled.',
		},
	},
	createOnce(context) {
		return {
			Property(node) {
				const keyName =
					node.key.type === 'Identifier' || node.key.type === 'PrivateIdentifier'
						? node.key.name
						: node.key.type === 'Literal'
							? node.key.value
							: undefined

				if (keyName === 'disableValidation' && node.value.type === 'Literal' && node.value.value === true) {
					context.report({ node, messageId: 'disabledValidation' })
				}
			},
		}
	},
})
