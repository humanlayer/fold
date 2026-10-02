import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const message = 'Do not use createMachine directly. Define machines with setup().createMachine().'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Create XState machines with setup().createMachine() to define their typed dependencies.',
		},
	},
	create(context) {
		const namespaceNames = new Set<string>()

		return {
			ImportDeclaration(node) {
				if (node.source.value !== 'xstate') {
					return
				}

				for (const specifier of node.specifiers) {
					if (specifier.type === 'ImportNamespaceSpecifier') {
						namespaceNames.add(specifier.local.name)
						continue
					}

					if (
						specifier.type === 'ImportSpecifier' &&
						specifier.imported.type === 'Identifier' &&
						specifier.imported.name === 'createMachine'
					) {
						context.report({
							node: specifier,
							message,
						})
					}
				}
			},
			MemberExpression(node) {
				if (
					node.object.type === 'Identifier' &&
					namespaceNames.has(node.object.name) &&
					node.property.type === 'Identifier' &&
					node.property.name === 'createMachine'
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
