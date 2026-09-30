import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

interface Options {
	readonly allowedLayoutFilenames?: ReadonlyArray<string>
	readonly routeDirectoryNames?: ReadonlyArray<string>
}

const rule: Rule = {
	meta: {
		type: 'suggestion' as const,
		docs: {
			description:
				'Avoid non-route layout files in app folders; rename them or use the nearest Next.js layout.tsx.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					allowedLayoutFilenames: {
						type: 'array',
						items: { type: 'string' },
					},
					routeDirectoryNames: {
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
		const allowedLayoutFilenames = new Set(options.allowedLayoutFilenames ?? ['layout.tsx', '_layout.tsx'])
		const routeDirectoryNames = new Set(options.routeDirectoryNames ?? ['app'])
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const basename = filename.slice(filename.lastIndexOf('/') + 1).toLowerCase()

		if (
			!filename.split('/').some((segment) => routeDirectoryNames.has(segment)) ||
			!basename.includes('layout') ||
			allowedLayoutFilenames.has(basename)
		) {
			return {}
		}

		return {
			Program(node) {
				context.report({
					node,
					message: 'Rename this file or use the nearest Next.js "layout.tsx" route primitive.',
				})
			},
		}
	},
}

export default rule
