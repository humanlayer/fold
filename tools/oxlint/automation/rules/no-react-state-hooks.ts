import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const bannedHooks = new Set(['useEffect', 'useReducer', 'useState'])

const message = (hookName: string) => `${hookName} is banned. Use xstate actors instead.`

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid React state and effect hooks; model component behavior with XState actors.',
		},
	},
	create(context) {
		const bannedImportedNames = new Set<string>()

		return {
			ImportDeclaration(node) {
				if (node.source.value !== 'react') return

				for (const specifier of node.specifiers) {
					if (specifier.type !== 'ImportSpecifier' || specifier.imported.type !== 'Identifier') {
						continue
					}

					const importedName = specifier.imported.name
					const localName = specifier.local.name

					if (importedName !== undefined && localName !== undefined && bannedHooks.has(importedName)) {
						bannedImportedNames.add(localName)
					}
				}
			},
			CallExpression(node) {
				const callee = node.callee

				if (
					callee.type === 'Identifier' &&
					(bannedImportedNames.has(callee.name) || bannedHooks.has(callee.name))
				) {
					context.report({
						node: callee,
						message: message(callee.name),
					})
				} else if (
					callee.type === 'MemberExpression' &&
					callee.property.type === 'Identifier' &&
					bannedHooks.has(callee.property.name)
				) {
					context.report({
						node: callee,
						message: message(callee.property.name),
					})
				}
			},
		}
	},
}

export default rule
