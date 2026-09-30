import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

interface Options {
	readonly ignoredPathMarkers?: ReadonlyArray<string>
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Disallow JSX style props in web code so styling stays in Tailwind theme utilities.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					ignoredPathMarkers: {
						type: 'array',
						items: { type: 'string' },
					},
				},
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const options = (context.options[0] ?? {}) as Options
		const ignoredPathMarkers = options.ignoredPathMarkers ?? ['/native/']

		if (!filename.endsWith('.tsx') || ignoredPathMarkers.some((marker) => filename.includes(marker))) {
			return {}
		}

		return {
			JSXAttribute(node) {
				if (node.name.type === 'JSXIdentifier' && node.name.name === 'style') {
					context.report({
						node,
						message:
							'Do not use JSX style props in web code. Use an existing Tailwind theme utility or the closest available theme value.',
					})
				}
			},
		}
	},
}

export default rule
