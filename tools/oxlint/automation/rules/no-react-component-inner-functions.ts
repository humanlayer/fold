import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type FunctionDeclarationNode = Parameters<NonNullable<VisitorObject['FunctionDeclaration']>>[0]
type FunctionExpressionNode = Parameters<NonNullable<VisitorObject['FunctionExpression']>>[0]
type ArrowFunctionExpressionNode = Parameters<NonNullable<VisitorObject['ArrowFunctionExpression']>>[0]
type FunctionNode = FunctionDeclarationNode | FunctionExpressionNode | ArrowFunctionExpressionNode

type Node = {
	readonly [key: string]: unknown
	readonly type: string
}

const functionTypes = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'])

const expressionWrapperTypes = new Set([
	'ChainExpression',
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSNonNullExpression',
	'TSSatisfiesExpression',
	'TSTypeAssertion',
])

const _isNode = (value: unknown): value is Node =>
	typeof value === 'object' &&
	value !== null &&
	Object.hasOwn(value, 'type') &&
	typeof Reflect.get(value, 'type') === 'string'

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

const _nodeParent = ({ node }: { node: Node }) => {
	const parent = _nodeField({ field: 'parent', node })

	return _isNode(parent) ? parent : undefined
}

const _nodeExpression = ({ node }: { node: Node }) => {
	const expression = _nodeField({ field: 'expression', node })

	return _isNode(expression) ? expression : undefined
}

const _isTsxFile = ({ filename }: { filename: string }) => filename.endsWith('.tsx')

const _isFunction = ({ node }: { node: Node | undefined }) => node !== undefined && functionTypes.has(node.type)

const _isComponentName = ({ name }: { name: string | undefined }) => name !== undefined && /^[A-Z]/.test(name)

const _componentName = ({ node }: { node: Node }): string | undefined => {
	if (node.type === 'FunctionDeclaration') {
		const name = _nodeName({ node: _nodeField({ field: 'id', node }) })

		return _isComponentName({ name }) ? name : undefined
	}

	const parent = _nodeParent({ node })

	if (parent?.type === 'VariableDeclarator') {
		const name = _nodeName({ node: _nodeField({ field: 'id', node: parent }) })

		return _isComponentName({ name }) ? name : undefined
	}

	if (parent?.type === 'CallExpression') {
		const variableDeclarator = _nodeParent({ node: parent })

		if (variableDeclarator?.type === 'VariableDeclarator') {
			const name = _nodeName({
				node: _nodeField({ field: 'id', node: variableDeclarator }),
			})

			return _isComponentName({ name }) ? name : undefined
		}
	}

	return undefined
}

const _owningComponent = ({ node }: { node: Node }) => {
	let current = _nodeParent({ node })

	while (current !== undefined) {
		if (_isFunction({ node: current })) {
			const name = _componentName({ node: current })

			return name === undefined ? undefined : { name, node: current }
		}

		current = _nodeParent({ node: current })
	}

	return undefined
}

const _outerExpression = ({ node }: { node: Node }) => {
	let current = node
	let parent = _nodeParent({ node: current })

	while (
		parent !== undefined &&
		expressionWrapperTypes.has(parent.type) &&
		_nodeExpression({ node: parent }) === current
	) {
		current = parent
		parent = _nodeParent({ node: current })
	}

	return current
}

const _isAssignedValue = ({ node }: { node: Node }) => {
	const parent = _nodeParent({ node })

	return (
		(parent?.type === 'VariableDeclarator' && _nodeField({ field: 'init', node: parent }) === node) ||
		(parent?.type === 'AssignmentExpression' && _nodeField({ field: 'right', node: parent }) === node)
	)
}

const _memberPropertyName = ({ node }: { node: Node }) => {
	const property = _nodeField({ field: 'property', node })

	return _isNode(property) && property.type === 'Identifier' ? _nodeName({ node: property }) : undefined
}

const _isUseCallbackCall = ({ node }: { node: Node }) => {
	const callee = _nodeField({ field: 'callee', node })

	if (!_isNode(callee)) {
		return false
	}

	return (
		(callee.type === 'Identifier' && _nodeName({ node: callee }) === 'useCallback') ||
		(callee.type === 'MemberExpression' && _memberPropertyName({ node: callee }) === 'useCallback')
	)
}

const _isUseCallbackValue = ({ node }: { node: Node }) => {
	const expression = _outerExpression({ node })
	const callExpression = _nodeParent({ node: expression })
	const [firstArgument] = callExpression === undefined ? [] : _nodeArray({ field: 'arguments', node: callExpression })

	if (
		callExpression?.type !== 'CallExpression' ||
		firstArgument !== expression ||
		!_isUseCallbackCall({ node: callExpression })
	) {
		return false
	}

	return _isAssignedValue({
		node: _outerExpression({ node: callExpression }),
	})
}

const _isComponentOwnedFunction = ({ node }: { node: Node }) => {
	if (node.type === 'FunctionDeclaration') {
		return true
	}

	const expression = _outerExpression({ node })

	return _isAssignedValue({ node: expression }) || _isUseCallbackValue({ node })
}

const _functionName = ({ node }: { node: Node }) => {
	if (node.type === 'FunctionDeclaration') {
		return _nodeName({ node: _nodeField({ field: 'id', node }) })
	}

	const expression = _outerExpression({ node })
	const parent = _nodeParent({ node: expression })

	if (parent?.type === 'VariableDeclarator') {
		return _nodeName({ node: _nodeField({ field: 'id', node: parent }) })
	}

	if (parent?.type === 'AssignmentExpression') {
		return _nodeName({ node: _nodeField({ field: 'left', node: parent }) })
	}

	if (parent?.type === 'CallExpression' && _isUseCallbackCall({ node: parent })) {
		const callbackOwner = _nodeParent({
			node: _outerExpression({ node: parent }),
		})

		return (
			_nodeName({
				node: callbackOwner === undefined ? undefined : _nodeField({ field: 'id', node: callbackOwner }),
			}) ??
			_nodeName({
				node: callbackOwner === undefined ? undefined : _nodeField({ field: 'left', node: callbackOwner }),
			})
		)
	}

	return undefined
}

const _message = ({ name }: { name: string | undefined }) =>
	name === undefined
		? 'Move this component-local function out of the component. If it contains business logic, model it in a state machine or actor instead. Avoid inlining the function into the component body unless no better boundary is possible.'
		: `Move "${name}" out of the component. If it contains business logic, model it in a state machine or actor instead. Avoid inlining the function into the component body unless no better boundary is possible.`

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Move named component-local functions to a state machine, actor, or external helper.',
		},
	},
	create(context) {
		const filename = context.filename ?? ''

		if (!_isTsxFile({ filename })) {
			return {}
		}

		const check_ = (node: FunctionNode) => {
			if (!_isNode(node)) {
				return
			}

			if (
				_nodeField({ field: 'body', node }) === undefined ||
				_owningComponent({ node }) === undefined ||
				!_isComponentOwnedFunction({ node })
			) {
				return
			}

			context.report({
				node,
				message: _message({ name: _functionName({ node }) }),
			})
		}

		return {
			ArrowFunctionExpression: check_,
			FunctionDeclaration: check_,
			FunctionExpression: check_,
		}
	},
}

export default rule
