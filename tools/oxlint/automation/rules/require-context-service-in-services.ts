import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type ClassDeclarationNode = Parameters<NonNullable<VisitorObject['ClassDeclaration']>>[0]

interface Options {
	readonly ignoredBasenames?: ReadonlyArray<string>
	readonly ignoredDirectoryNames?: ReadonlyArray<string>
	readonly serviceDirectoryNames?: ReadonlyArray<string>
}

type Node = {
	readonly [key: string]: unknown
	readonly type: string
}

const _isNode = (value: unknown): value is Node =>
	typeof value === 'object' &&
	value !== null &&
	Object.hasOwn(value, 'type') &&
	typeof Reflect.get(value, 'type') === 'string'

const _nodeField = ({ field, node }: { field: string; node: Node }) => node[field]

const _identifierName = ({ node }: { node: unknown }) =>
	_isNode(node) && node.type === 'Identifier' && typeof _nodeField({ field: 'name', node }) === 'string'
		? _nodeField({ field: 'name', node })
		: undefined

const _isContextService = ({ node }: { node: unknown }): boolean => {
	if (!_isNode(node)) {
		return false
	}

	if (node.type === 'MemberExpression') {
		return (
			_identifierName({
				node: _nodeField({ field: 'object', node }),
			}) === 'Context' &&
			_identifierName({
				node: _nodeField({ field: 'property', node }),
			}) === 'Service'
		)
	}

	if (node.type === 'CallExpression') {
		return _isContextService({
			node: _nodeField({ field: 'callee', node }),
		})
	}

	if (
		node.type === 'ChainExpression' ||
		node.type === 'ParenthesizedExpression' ||
		node.type === 'TSInstantiationExpression'
	) {
		return _isContextService({
			node: _nodeField({ field: 'expression', node }),
		})
	}

	return false
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Require production modules in services folders to define a class extending Context.Service.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					ignoredBasenames: {
						type: 'array',
						items: { type: 'string' },
					},
					ignoredDirectoryNames: {
						type: 'array',
						items: { type: 'string' },
					},
					serviceDirectoryNames: {
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
		const ignoredBasenames = new Set(options.ignoredBasenames ?? ['index.ts', 'main.ts'])
		const ignoredDirectoryNames = new Set(options.ignoredDirectoryNames ?? ['test', 'tests', '__tests__'])
		const serviceDirectoryNames = new Set(options.serviceDirectoryNames ?? ['service', 'services'])
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const basename = filename.slice(filename.lastIndexOf('/') + 1)
		const segments = filename.split('/')

		if (
			(!filename.endsWith('.ts') && !filename.endsWith('.tsx')) ||
			filename.endsWith('.d.ts') ||
			!segments.some((segment) => serviceDirectoryNames.has(segment)) ||
			segments.some((segment) => ignoredDirectoryNames.has(segment)) ||
			basename.endsWith('.test.ts') ||
			basename.endsWith('.test.tsx') ||
			basename.endsWith('.spec.ts') ||
			basename.endsWith('.spec.tsx') ||
			ignoredBasenames.has(basename)
		) {
			return {}
		}

		let definesContextService = false

		return {
			ClassDeclaration(node: ClassDeclarationNode) {
				if (
					_isContextService({
						node: node.superClass,
					})
				) {
					definesContextService = true
				}
			},
			'Program:exit'(node) {
				if (definesContextService) {
					return
				}

				context.report({
					node,
					message: 'Files inside services folders must define a class extending Context.Service.',
				})
			},
		}
	},
}

export default rule
