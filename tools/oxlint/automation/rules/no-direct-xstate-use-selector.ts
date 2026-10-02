import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

interface Options {
	readonly preferredModule?: string
	readonly selectorModules?: ReadonlyArray<string>
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description:
				'Import typed selector hooks from a repository-owned facade instead of using XState useSelector directly.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					preferredModule: { type: 'string' },
					selectorModules: {
						type: 'array',
						items: { type: 'string' },
					},
				},
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const options = (context.options[0] ?? {}) as Options
		const xstateSelectorModules = new Set(options.selectorModules ?? ['@xstate/react', '@xstate/store/react'])
		const preferredModule = options.preferredModule ?? 'a repository-owned typed selector facade'
		const message = `Use selector hooks from ${preferredModule} instead of XState useSelector directly.`
		const isXstateSelectorModule = ({ value }: { value: unknown }) =>
			typeof value === 'string' && xstateSelectorModules.has(value)
		const namespaceNames = new Set<string>()

		return {
			ImportDeclaration(node) {
				if (!isXstateSelectorModule({ value: node.source.value })) {
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
						specifier.imported.name === 'useSelector'
					) {
						context.report({
							node: specifier,
							message,
						})
					}
				}
			},
			MemberExpression(node) {
				const isDirectNamespaceSelector =
					node.object.type === 'Identifier' &&
					namespaceNames.has(node.object.name) &&
					node.property.type === 'Identifier' &&
					node.property.name === 'useSelector'

				if (!isDirectNamespaceSelector) {
					return
				}

				context.report({
					node,
					message,
				})
			},
		}
	},
}

export default rule
