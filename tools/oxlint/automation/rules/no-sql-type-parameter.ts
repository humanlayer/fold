import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid sql<Type> templates; use typed query APIs or validated schemas.',
		},
	},
	create(context) {
		return {
			TaggedTemplateExpression(node) {
				const isSqlTag =
					(node.tag.type === 'Identifier' && node.tag.name === 'sql') ||
					(node.tag.type === 'MemberExpression' &&
						node.tag.property.type === 'Identifier' &&
						node.tag.property.name === 'sql')
				const hasTypeParameters =
					(node.typeArguments !== undefined && node.typeArguments !== null) ||
					('typeParameters' in node && node.typeParameters !== undefined && node.typeParameters !== null)

				if (isSqlTag && hasTypeParameters) {
					context.report({
						node,
						message:
							'Do not use sql<Type> templates. Use typed Drizzle/D1 query APIs or validated schemas instead.',
					})
				}
			},
		}
	},
}

export default rule
