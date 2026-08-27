import { defineRule } from '@oxlint/plugins'

// Vendored and adapted from typeonce-dev/ai-automation (rules/oxlint/src/rules/no-service-option.ts).
// This rule protects production dependency boundaries. Tests that explicitly inspect whether a service is
// present are excluded through `.oxlintrc.jsonc` rather than weakening the production rule.

export default defineRule({
	meta: {
		type: 'problem',
		docs: {
			description: 'Require Effect services directly and provide them at the owning layer or composition root.',
		},
		messages: {
			optionalService:
				'Do not use Effect.serviceOption for production dependencies. Require the service directly and provide it in the layer.',
		},
	},
	createOnce(context) {
		return {
			MemberExpression(node) {
				if (
					node.object.type === 'Identifier' &&
					node.object.name === 'Effect' &&
					node.property.type === 'Identifier' &&
					node.property.name === 'serviceOption'
				) {
					context.report({ node, messageId: 'optionalService' })
				}
			},
		}
	},
})
