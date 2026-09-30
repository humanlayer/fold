import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

interface Options {
	readonly applicationPathMarkers?: ReadonlyArray<string>
	readonly bannedElements?: ReadonlyArray<string>
	readonly linkModule?: string
}

const _identifierName = (node: { readonly name?: string; readonly type: string }) =>
	node.type === 'Identifier' ? node.name : undefined

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Require app UI to use approved interactive components and import Link from next/link.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					applicationPathMarkers: {
						type: 'array',
						items: { type: 'string' },
					},
					bannedElements: {
						type: 'array',
						items: { type: 'string' },
					},
					linkModule: { type: 'string' },
				},
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const options = (context.options[0] ?? {}) as Options
		const applicationPathMarkers = options.applicationPathMarkers ?? ['/applications/']
		const bannedIntrinsicElements = new Set(options.bannedElements ?? ['button', 'form'])
		const linkModule = options.linkModule ?? 'next/link'

		if (!applicationPathMarkers.some((marker) => filename.includes(marker)) || !filename.endsWith('.tsx')) {
			return {}
		}

		return {
			ImportDeclaration(node) {
				if (node.source.value === linkModule) {
					return
				}

				const importsLink = node.specifiers.some((specifier) => {
					if (specifier.type === 'ImportSpecifier') {
						return _identifierName(specifier.imported) === 'Link' || specifier.local.name === 'Link'
					}

					return specifier.local.name === 'Link'
				})

				if (!importsLink) {
					return
				}

				context.report({
					node,
					message: `Import Link from ${linkModule}.`,
				})
			},
			JSXOpeningElement(node) {
				if (node.name.type !== 'JSXIdentifier' || !bannedIntrinsicElements.has(node.name.name)) {
					return
				}

				context.report({
					node: node.name,
					message: `Use an approved design-system component instead of <${node.name.name}>.`,
				})
			},
		}
	},
}

export default rule
