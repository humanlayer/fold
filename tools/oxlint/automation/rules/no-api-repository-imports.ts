import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

interface Options {
	readonly handlerDirectoryNames?: ReadonlyArray<string>
	readonly repositoryDirectoryNames?: ReadonlyArray<string>
	readonly testDirectoryNames?: ReadonlyArray<string>
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description:
				'Prevent API and route handlers from importing repositories directly; call the owning service instead.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					handlerDirectoryNames: {
						type: 'array',
						items: { type: 'string' },
					},
					repositoryDirectoryNames: {
						type: 'array',
						items: { type: 'string' },
					},
					testDirectoryNames: {
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
		const handlerDirectoryNames = new Set(options.handlerDirectoryNames ?? ['api', 'routes'])
		const repositoryDirectoryNames = new Set(options.repositoryDirectoryNames ?? ['repository', 'repositories'])
		const testDirectoryNames = new Set(options.testDirectoryNames ?? ['test', 'tests', '__tests__'])
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const filenameSegments = filename.split('/')

		if (
			!filenameSegments.some((segment) => handlerDirectoryNames.has(segment)) ||
			filenameSegments.some((segment) => testDirectoryNames.has(segment))
		) {
			return {}
		}

		return {
			ImportDeclaration(node) {
				if (
					typeof node.source.value !== 'string' ||
					!node.source.value
						.replaceAll('\\', '/')
						.split('/')
						.some((segment) => repositoryDirectoryNames.has(segment))
				) {
					return
				}

				context.report({
					node,
					message: 'API and route handlers must call a service instead of importing a repository directly.',
				})
			},
		}
	},
}

export default rule
