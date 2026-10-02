import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

interface Options {
	readonly allowedFilenames?: ReadonlyArray<string>
	readonly routeDirectoryNames?: ReadonlyArray<string>
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Disallow modules whose only responsibility is re-exporting other modules.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					allowedFilenames: {
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
		const allowedFilenames = new Set(options.allowedFilenames ?? ['loading.tsx', 'not-found.tsx'])
		const routeDirectoryNames = new Set(options.routeDirectoryNames ?? ['app'])
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const segments = filename.split('/')
		const basename = segments.at(-1) ?? ''

		if (segments.some((segment) => routeDirectoryNames.has(segment)) && allowedFilenames.has(basename)) {
			return {}
		}

		return {
			Program(node) {
				const statements = node.body.filter(
					(statement) => statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string',
				)

				if (
					statements.length === 0 ||
					!statements.every(
						(statement) =>
							statement.type === 'ExportAllDeclaration' ||
							(statement.type === 'ExportNamedDeclaration' && statement.source !== null),
					)
				) {
					return
				}

				context.report({
					node,
					message:
						'Do not create re-export-only modules. Import from the owning module directly or add this intentional public entrypoint as an exact lint override.',
				})
			},
		}
	},
}

export default rule
