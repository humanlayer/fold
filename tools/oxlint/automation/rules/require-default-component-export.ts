import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type ProgramNode = Parameters<NonNullable<VisitorObject['Program']>>[0]

interface Options {
	readonly applicationPathMarkers?: ReadonlyArray<string>
	readonly ignoredFilenamePatterns?: ReadonlyArray<string>
	readonly wrapperNames?: ReadonlyArray<string>
}

type Node = {
	readonly [key: string]: unknown
	readonly type: string
}

type RangedNode = Node & {
	readonly range: [number, number]
}

let componentWrapperNames: ReadonlySet<string> = new Set(['forwardRef', 'memo'])

const _isNode = (value: unknown): value is Node =>
	typeof value === 'object' &&
	value !== null &&
	Object.hasOwn(value, 'type') &&
	typeof Reflect.get(value, 'type') === 'string'

const _isRangedNode = (value: unknown): value is RangedNode =>
	_isNode(value) &&
	Array.isArray(value.range) &&
	value.range.length === 2 &&
	typeof value.range[0] === 'number' &&
	typeof value.range[1] === 'number'

const _nodeField = ({ field, node }: { field: string; node: Node }) => node[field]

const _nodeArray = ({ field, node }: { field: string; node: Node }) => {
	const value = _nodeField({ field, node })

	return Array.isArray(value) ? value.filter(_isNode) : []
}

const _nodeName = ({ node }: { node: unknown }) => {
	if (!_isNode(node)) {
		return undefined
	}

	const name = _nodeField({ field: 'name', node })

	return typeof name === 'string' ? name : undefined
}

const _isPascalCase = ({ name }: { name: string | undefined }) => name !== undefined && /^[A-Z]/.test(name)

const _isComponentValue = ({ node }: { node: unknown }) => {
	if (!_isNode(node)) {
		return false
	}

	if (
		node.type === 'ArrowFunctionExpression' ||
		node.type === 'FunctionExpression' ||
		node.type === 'ClassExpression'
	) {
		return true
	}

	if (node.type !== 'CallExpression') {
		return false
	}

	const callee = _nodeField({ field: 'callee', node })

	if (!_isNode(callee)) {
		return false
	}

	const wrapperName =
		callee.type === 'Identifier'
			? _nodeName({ node: callee })
			: callee.type === 'MemberExpression'
				? _nodeName({
						node: _nodeField({ field: 'property', node: callee }),
					})
				: undefined

	return wrapperName !== undefined && componentWrapperNames.has(wrapperName)
}

const _declarationComponentNames = ({ node }: { node: Node }) => {
	if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
		const name = _nodeName({ node: _nodeField({ field: 'id', node }) })

		return _isPascalCase({ name }) && name !== undefined ? [name] : []
	}

	if (node.type !== 'VariableDeclaration') {
		return []
	}

	return _nodeArray({ field: 'declarations', node }).flatMap((declaration) => {
		const name = _nodeName({
			node: _nodeField({ field: 'id', node: declaration }),
		})
		const value = _nodeField({ field: 'init', node: declaration })

		return _isPascalCase({ name }) && name !== undefined && _isComponentValue({ node: value }) ? [name] : []
	})
}

const _componentBindings = ({ node }: { node: Node }) => {
	const names = new Set<string>()

	for (const statement of _nodeArray({ field: 'body', node })) {
		const declaration =
			statement.type === 'ExportNamedDeclaration'
				? _nodeField({ field: 'declaration', node: statement })
				: statement

		if (!_isNode(declaration)) {
			continue
		}

		for (const name of _declarationComponentNames({ node: declaration })) {
			names.add(name)
		}
	}

	return names
}

const _exportedComponentNames = ({
	componentBindings,
	node,
}: {
	componentBindings: ReadonlySet<string>
	node: Node
}) => {
	const declaration = _nodeField({ field: 'declaration', node })
	const names = _isNode(declaration) ? _declarationComponentNames({ node: declaration }) : []

	for (const specifier of _nodeArray({ field: 'specifiers', node })) {
		const exportedName = _nodeName({
			node: _nodeField({ field: 'exported', node: specifier }),
		})
		const localName = _nodeName({
			node: _nodeField({ field: 'local', node: specifier }),
		})

		if (exportedName !== 'default' && localName !== undefined && componentBindings.has(localName)) {
			names.push(localName)
		}
	}

	return names
}

const _deferredDefaultComponentNames = ({
	componentBindings,
	node,
}: {
	componentBindings: ReadonlySet<string>
	node: Node
}) => {
	if (node.type === 'ExportDefaultDeclaration') {
		const name = _nodeName({
			node: _nodeField({ field: 'declaration', node }),
		})

		return name !== undefined && componentBindings.has(name) ? [name] : []
	}

	if (node.type !== 'ExportNamedDeclaration') {
		return []
	}

	return _nodeArray({ field: 'specifiers', node }).flatMap((specifier) => {
		const exportedName = _nodeName({
			node: _nodeField({ field: 'exported', node: specifier }),
		})
		const localName = _nodeName({
			node: _nodeField({ field: 'local', node: specifier }),
		})

		return exportedName === 'default' && localName !== undefined && componentBindings.has(localName)
			? [localName]
			: []
	})
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description:
				'Require app component files to default-export one main component and keep supporting components local.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					applicationPathMarkers: {
						type: 'array',
						items: { type: 'string' },
					},
					ignoredFilenamePatterns: {
						type: 'array',
						items: { type: 'string' },
					},
					wrapperNames: {
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
		const applicationPathMarkers = options.applicationPathMarkers ?? ['/applications/']
		const ignoredFilenamePatterns = options.ignoredFilenamePatterns ?? ['(?:^|-)icons\\.tsx$']
		componentWrapperNames = new Set(options.wrapperNames ?? ['forwardRef', 'memo'])
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const basename = filename.slice(filename.lastIndexOf('/') + 1)

		if (
			!applicationPathMarkers.some((marker) => filename.includes(marker)) ||
			!filename.endsWith('.tsx') ||
			ignoredFilenamePatterns.some((pattern) => new RegExp(pattern).test(basename))
		) {
			return {}
		}

		return {
			Program(node: ProgramNode) {
				if (!_isNode(node)) {
					return
				}

				const componentBindings = _componentBindings({ node })

				for (const statement of _nodeArray({ field: 'body', node })) {
					const deferredDefaultNames = _deferredDefaultComponentNames({
						componentBindings,
						node: statement,
					})

					if (deferredDefaultNames.length > 0 && _isRangedNode(statement)) {
						context.report({
							node: statement,
							message: `Declare ${deferredDefaultNames.join(', ')} with export default directly on the function definition.`,
						})
					}

					if (
						statement.type !== 'ExportNamedDeclaration' ||
						_nodeField({ field: 'source', node: statement }) !== null
					) {
						continue
					}

					const names = _exportedComponentNames({
						componentBindings,
						node: statement,
					})

					if (names.length === 0) {
						continue
					}

					if (!_isRangedNode(statement)) {
						continue
					}

					context.report({
						node: statement,
						message: `Export one main component as default and keep supporting components local. Named component export${names.length === 1 ? '' : 's'}: ${names.join(', ')}.`,
					})
				}
			},
		}
	},
}

export default rule
