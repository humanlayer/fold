import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type ProgramNode = Parameters<NonNullable<VisitorObject['Program']>>[0]

type Node = {
	readonly [key: string]: unknown
	readonly type: string
}

type RangedNode = Node & {
	readonly range: [number, number]
}

type FunctionBinding = {
	readonly name: string
	readonly node: Node
	readonly value: Node
}

type FunctionExport = {
	readonly binding: FunctionBinding | undefined
	readonly name: string | undefined
	readonly node: RangedNode
}

interface Options {
	readonly frameworkSegmentBasenames?: ReadonlyArray<string>
	readonly frameworkSpecialExports?: ReadonlyArray<string>
}

const functionExpressionTypes = new Set(['ArrowFunctionExpression', 'FunctionExpression'])

const expressionWrapperTypes = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSNonNullExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
])

const componentWrapperNames = new Set(['forwardRef', 'memo'])

let frameworkSpecialFunctionExports: ReadonlySet<string> = new Set([
	'generateImageMetadata',
	'generateMetadata',
	'generateSitemaps',
	'generateStaticParams',
	'generateViewport',
])

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

const _nodeValue = ({ node }: { node: unknown }) => (_isNode(node) ? _nodeField({ field: 'value', node }) : undefined)

const _nodeExpression = ({ node }: { node: Node }) => {
	const expression = _nodeField({ field: 'expression', node })

	return _isNode(expression) ? expression : undefined
}

const _isTsxFile = ({ filename }: { filename: string }) => filename.endsWith('.tsx')

const _isPascalCase = ({ name }: { name: string | undefined }) => name !== undefined && /^[A-Z]/.test(name)

let frameworkSegmentBasenames: ReadonlySet<string> = new Set(['page.tsx', 'layout.tsx'])

const _isFrameworkSegmentFile = ({ filename }: { filename: string }) =>
	frameworkSegmentBasenames.has(filename.replaceAll('\\', '/').split('/').at(-1) ?? '')

const _isNextAppRouterSpecialFunctionExport = ({
	exportedFunction,
	filename,
}: {
	exportedFunction: FunctionExport
	filename: string
}) => {
	if (!_isFrameworkSegmentFile({ filename })) {
		return false
	}

	const name = exportedFunction.binding?.name ?? exportedFunction.name

	return name !== undefined && frameworkSpecialFunctionExports.has(name)
}

const _bindingIdentifierName = ({ node }: { node: unknown }) =>
	_isNode(node) && node.type === 'Identifier' ? _nodeName({ node }) : undefined

const _memberPropertyName = ({ node }: { node: Node }) => {
	const property = _nodeField({ field: 'property', node })
	const propertyValue = _nodeValue({ node: property })

	if (_isNode(property) && property.type === 'Identifier') {
		return _nodeName({ node: property })
	}

	return typeof propertyValue === 'string' ? propertyValue : undefined
}

const _innerExpression = ({ node }: { node: Node }) => {
	let current = node
	let expression = _nodeExpression({ node: current })

	while (expressionWrapperTypes.has(current.type) && expression !== undefined) {
		current = expression
		expression = _nodeExpression({ node: current })
	}

	return current
}

const _isFunctionExpression = ({ node }: { node: Node }) => functionExpressionTypes.has(_innerExpression({ node }).type)

const _componentWrapperName = ({ node }: { node: Node }) => {
	if (node.type === 'Identifier') {
		const name = _nodeName({ node })

		return name !== undefined && componentWrapperNames.has(name) ? name : undefined
	}

	if (node.type !== 'MemberExpression') {
		return undefined
	}

	return _memberPropertyName({ node })
}

const _isComponentWrapperCall = ({ node }: { node: Node }) => {
	if (node.type !== 'CallExpression') {
		return false
	}

	const callee = _nodeField({ field: 'callee', node })

	if (!_isNode(callee)) {
		return false
	}

	const name = _componentWrapperName({ node: callee })

	return name !== undefined && componentWrapperNames.has(name)
}

const _isFunctionValue = ({
	bindings,
	node,
}: {
	bindings: ReadonlyMap<string, FunctionBinding> | undefined
	node: Node
}): boolean => {
	const expression = _innerExpression({ node })
	const name = _nodeName({ node: expression })

	if (expression.type === 'Identifier' && name !== undefined) {
		return bindings?.has(name) ?? false
	}

	if (expression.type === 'FunctionDeclaration') {
		return true
	}

	if (_isFunctionExpression({ node: expression })) {
		return true
	}

	if (!_isComponentWrapperCall({ node: expression })) {
		return false
	}

	const [argument] = _nodeArray({ field: 'arguments', node: expression })

	return argument !== undefined && _isFunctionValue({ bindings, node: argument })
}

const _functionBindingFromDeclaration = ({ node }: { node: Node }): FunctionBinding | undefined => {
	if (node.type !== 'FunctionDeclaration') {
		return undefined
	}

	const name = _bindingIdentifierName({
		node: _nodeField({ field: 'id', node }),
	})

	return name === undefined ? undefined : { name, node, value: node }
}

const _functionBindingFromDeclarator = ({
	bindings,
	node,
}: {
	bindings: ReadonlyMap<string, FunctionBinding> | undefined
	node: Node
}): FunctionBinding | undefined => {
	const name = _bindingIdentifierName({
		node: _nodeField({ field: 'id', node }),
	})
	const init = _nodeField({ field: 'init', node })

	if (name === undefined || !_isNode(init) || !_isFunctionValue({ bindings, node: init })) {
		return undefined
	}

	return { name, node, value: init }
}

const _functionBindingFromExpression = ({
	bindings,
	node,
}: {
	bindings: ReadonlyMap<string, FunctionBinding>
	node: Node
}): FunctionBinding | undefined => {
	const expression = _innerExpression({ node })
	const name = _nodeName({ node: expression })

	if (expression.type === 'Identifier' && name !== undefined) {
		return bindings.get(name)
	}

	if (!_isComponentWrapperCall({ node: expression })) {
		return undefined
	}

	const [argument] = _nodeArray({ field: 'arguments', node: expression })

	return argument === undefined ? undefined : _functionBindingFromExpression({ bindings, node: argument })
}

const _functionNameFromExpression = ({
	bindings,
	node,
}: {
	bindings: ReadonlyMap<string, FunctionBinding>
	node: Node
}): string | undefined => {
	const binding = _functionBindingFromExpression({ bindings, node })

	if (binding !== undefined) {
		return binding.name
	}

	const expression = _innerExpression({ node })

	if (expression.type === 'FunctionDeclaration' || expression.type === 'FunctionExpression') {
		return _bindingIdentifierName({
			node: _nodeField({ field: 'id', node: expression }),
		})
	}

	if (!_isComponentWrapperCall({ node: expression })) {
		return undefined
	}

	const [argument] = _nodeArray({ field: 'arguments', node: expression })

	return argument === undefined ? undefined : _functionNameFromExpression({ bindings, node: argument })
}

const _addTopLevelBinding = ({ bindings, node }: { bindings: Map<string, FunctionBinding>; node: Node }) => {
	const binding =
		node.type === 'FunctionDeclaration'
			? _functionBindingFromDeclaration({ node })
			: node.type === 'VariableDeclarator'
				? _functionBindingFromDeclarator({ bindings, node })
				: undefined

	if (binding === undefined || bindings.has(binding.name)) {
		return false
	}

	bindings.set(binding.name, binding)

	return true
}

const _topLevelDeclarations = ({ node }: { node: Node }) => {
	const declarations: Array<Node> = []

	for (const statement of _nodeArray({ field: 'body', node })) {
		const source = _nodeField({ field: 'source', node: statement })
		const declaration = _nodeField({ field: 'declaration', node: statement })

		if (
			statement.type === 'ExportNamedDeclaration' &&
			(source === null || source === undefined) &&
			_isNode(declaration)
		) {
			declarations.push(declaration)
			continue
		}

		declarations.push(statement)
	}

	return declarations
}

const _addTopLevelDeclarationBindings = ({
	bindings,
	node,
}: {
	bindings: Map<string, FunctionBinding>
	node: Node
}) => {
	if (node.type === 'FunctionDeclaration') {
		return _addTopLevelBinding({ bindings, node })
	}

	if (node.type !== 'VariableDeclaration') {
		return false
	}

	let added = false

	for (const declaration of _nodeArray({ field: 'declarations', node })) {
		if (_addTopLevelBinding({ bindings, node: declaration })) {
			added = true
		}
	}

	return added
}

const _topLevelFunctionBindings = ({ node }: { node: Node }) => {
	const bindings = new Map<string, FunctionBinding>()
	const declarations = _topLevelDeclarations({ node })
	let added = true

	while (added) {
		added = false

		for (const declaration of declarations) {
			if (_addTopLevelDeclarationBindings({ bindings, node: declaration })) {
				added = true
			}
		}
	}

	return bindings
}

const _functionExport = ({
	binding,
	name,
	node,
}: {
	binding: FunctionBinding | undefined
	name: string | undefined
	node: Node
}) => (_isRangedNode(node) ? [{ binding, name, node }] : [])

const _exportsFromDeclaration = ({
	bindings,
	declaration,
	node,
}: {
	bindings: ReadonlyMap<string, FunctionBinding>
	declaration: Node | undefined
	node: Node
}) => {
	if (declaration?.type === 'FunctionDeclaration') {
		const binding = _functionBindingFromDeclaration({ node: declaration })

		return binding === undefined ? [] : _functionExport({ binding, name: binding.name, node })
	}

	if (declaration?.type !== 'VariableDeclaration') {
		return []
	}

	return _nodeArray({ field: 'declarations', node: declaration }).flatMap((variable) => {
		const binding = _functionBindingFromDeclarator({
			bindings,
			node: variable,
		})

		return binding === undefined ? [] : _functionExport({ binding, name: binding.name, node })
	})
}

const _exportsFromSpecifier = ({ bindings, node }: { bindings: ReadonlyMap<string, FunctionBinding>; node: Node }) => {
	const name = _bindingIdentifierName({
		node: _nodeField({ field: 'local', node }),
	})
	const binding = name === undefined ? undefined : bindings.get(name)

	return binding === undefined ? [] : _functionExport({ binding, name, node })
}

const _exportsFromDefaultDeclaration = ({
	bindings,
	node,
}: {
	bindings: ReadonlyMap<string, FunctionBinding>
	node: Node
}) => {
	const declaration = _nodeField({ field: 'declaration', node })

	if (!_isNode(declaration)) {
		return []
	}

	if (declaration.type === 'Identifier') {
		const name = _nodeName({ node: declaration })
		const binding = name === undefined ? undefined : bindings.get(name)

		return binding === undefined ? [] : _functionExport({ binding, name, node })
	}

	if (!_isFunctionValue({ bindings, node: declaration })) {
		return []
	}

	const binding = _functionBindingFromExpression({
		bindings,
		node: declaration,
	})
	const name = binding?.name ?? _functionNameFromExpression({ bindings, node: declaration })

	return _functionExport({ binding, name, node })
}

const _functionExports = ({ node }: { node: Node }) => {
	const bindings = _topLevelFunctionBindings({ node })
	const exports: Array<FunctionExport> = []

	for (const statement of _nodeArray({ field: 'body', node })) {
		if (statement.type === 'ExportDefaultDeclaration') {
			exports.push(..._exportsFromDefaultDeclaration({ bindings, node: statement }))
			continue
		}

		if (statement.type !== 'ExportNamedDeclaration') {
			continue
		}

		const source = _nodeField({ field: 'source', node: statement })

		if (source !== null && source !== undefined) {
			continue
		}

		const declaration = _nodeField({ field: 'declaration', node: statement })

		exports.push(
			..._exportsFromDeclaration({
				bindings,
				declaration: _isNode(declaration) ? declaration : undefined,
				node: statement,
			}),
		)

		for (const specifier of _nodeArray({
			field: 'specifiers',
			node: statement,
		})) {
			exports.push(..._exportsFromSpecifier({ bindings, node: specifier }))
		}
	}

	return exports
}

const _componentName = ({ exportedFunction }: { exportedFunction: FunctionExport }) =>
	exportedFunction.binding?.name ?? exportedFunction.name

const _isComponentExport = ({ exportedFunction }: { exportedFunction: FunctionExport }) =>
	_isPascalCase({ name: _componentName({ exportedFunction }) })

const _message = ({ name }: { name: string | undefined }) =>
	name === undefined
		? 'Move this exported function out of the TSX file. TSX files should export components only.'
		: `Move "${name}" out of the TSX file. TSX files should export components only.`

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Export only components from TSX files; move other exported functions to a non-TSX module.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					frameworkSegmentBasenames: {
						type: 'array',
						items: { type: 'string' },
					},
					frameworkSpecialExports: {
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
		frameworkSegmentBasenames = new Set(options.frameworkSegmentBasenames ?? ['page.tsx', 'layout.tsx'])
		frameworkSpecialFunctionExports = new Set(
			options.frameworkSpecialExports ?? [
				'generateImageMetadata',
				'generateMetadata',
				'generateSitemaps',
				'generateStaticParams',
				'generateViewport',
			],
		)
		const filename = context.filename ?? ''

		if (!_isTsxFile({ filename })) {
			return {}
		}

		return {
			Program(node: ProgramNode) {
				if (!_isNode(node)) {
					return
				}

				for (const exportedFunction of _functionExports({ node })) {
					if (
						_isComponentExport({ exportedFunction }) ||
						_isNextAppRouterSpecialFunctionExport({
							exportedFunction,
							filename,
						})
					) {
						continue
					}

					context.report({
						node: exportedFunction.node,
						message: _message({ name: _componentName({ exportedFunction }) }),
					})
				}
			},
		}
	},
}

export default rule
