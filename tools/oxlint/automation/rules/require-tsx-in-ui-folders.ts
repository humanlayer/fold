import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

interface Options {
	readonly allowedTypeScriptFiles?: ReadonlyArray<string>
	readonly uiDirectoryNames?: ReadonlyArray<string>
}

const defaultAllowedTypeScriptFiles = [
	'apple-icon.ts',
	'icon.ts',
	'manifest.ts',
	'opengraph-image.ts',
	'robots.ts',
	'route.ts',
	'sitemap.ts',
	'twitter-image.ts',
]

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description:
				'Keep UI modules in app and components folders as TSX; move non-UI modules to their owning lib folder.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					allowedTypeScriptFiles: {
						type: 'array',
						items: { type: 'string' },
					},
					uiDirectoryNames: {
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
		const allowedTypeScriptFiles = new Set(options.allowedTypeScriptFiles ?? defaultAllowedTypeScriptFiles)
		const uiDirectoryNames = new Set(options.uiDirectoryNames ?? ['app', 'components'])
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const basename = filename.slice(filename.lastIndexOf('/') + 1)
		const segments = filename.split('/')

		if (
			!filename.endsWith('.ts') ||
			filename.endsWith('.d.ts') ||
			allowedTypeScriptFiles.has(basename) ||
			!segments.some((segment) => uiDirectoryNames.has(segment))
		) {
			return {}
		}

		return {
			Program(node) {
				context.report({
					node,
					message:
						'Only TSX files belong in app and components folders. Move this non-UI module to its owning lib folder.',
				})
			},
		}
	},
}

export default rule
