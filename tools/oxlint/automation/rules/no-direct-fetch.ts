import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const message = 'Do not call fetch directly. Use the existing API client or runtime client service.'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid direct fetch calls; use the existing API client or runtime client service.',
		},
	},
	create(context) {
		return {
			CallExpression(node) {
				const callee = node.callee

				if (callee.type === 'Identifier' && callee.name === 'fetch') {
					context.report({
						node,
						message,
					})
					return
				}

				if (
					callee.type === 'MemberExpression' &&
					callee.property.type === 'Identifier' &&
					callee.property.name === 'fetch' &&
					callee.object.type === 'Identifier' &&
					(callee.object.name === 'window' || callee.object.name === 'globalThis')
				) {
					context.report({
						node,
						message,
					})
				}
			},
		}
	},
}

export default rule
