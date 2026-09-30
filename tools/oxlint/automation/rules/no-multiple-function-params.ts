import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type FunctionDeclarationNode = Parameters<NonNullable<VisitorObject['FunctionDeclaration']>>[0]
type FunctionExpressionNode = Parameters<NonNullable<VisitorObject['FunctionExpression']>>[0]
type ArrowFunctionExpressionNode = Parameters<NonNullable<VisitorObject['ArrowFunctionExpression']>>[0]
type FunctionNode = FunctionDeclarationNode | FunctionExpressionNode | ArrowFunctionExpressionNode

interface Options {
	readonly exemptFunctionNames?: ReadonlyArray<string>
	readonly exemptRouteBasenames?: ReadonlyArray<string>
}

const maxParams = 1

const httpMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'])

const message = 'Functions with more than one parameter must accept a single object parameter.'

const _isCallback = (parent: { readonly type: string } | null | undefined) =>
	parent?.type === 'CallExpression' || parent?.type === 'NewExpression' || parent?.type === 'JSXExpressionContainer'

const _isOwnedFunction = (node: FunctionNode) => {
	if (node.type === 'FunctionDeclaration') {
		return true
	}

	const parent = node.parent

	if (_isCallback(parent)) {
		return false
	}

	return (
		parent?.type === 'VariableDeclarator' ||
		parent?.type === 'AssignmentExpression' ||
		parent?.type === 'ExportDefaultDeclaration'
	)
}

const _isRouteFile = ({ basenames, filename }: { basenames: ReadonlySet<string>; filename: string }) =>
	basenames.has(filename.replaceAll('\\', '/').split('/').at(-1) ?? '')

const _identifierName = ({ node }: { node: { readonly name?: string; readonly type: string } | null }) =>
	node?.type === 'Identifier' ? node.name : undefined

const _isExportedHttpRouteHandler = ({
	filename,
	httpRouteFunctionNames,
	routeBasenames,
	node,
}: {
	filename: string
	httpRouteFunctionNames: ReadonlySet<string>
	routeBasenames: ReadonlySet<string>
	node: FunctionNode
}) => {
	if (!_isRouteFile({ basenames: routeBasenames, filename }) || node.type !== 'FunctionDeclaration') {
		return false
	}

	const parent = node.parent
	const name = _identifierName({ node: node.id })

	return parent?.type === 'ExportNamedDeclaration' && name !== undefined && httpRouteFunctionNames.has(name)
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Require internally defined functions with multiple inputs to accept one object parameter.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					exemptFunctionNames: {
						type: 'array',
						items: { type: 'string' },
					},
					exemptRouteBasenames: {
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
		const httpRouteFunctionNames = new Set(options.exemptFunctionNames ?? httpMethods)
		const routeBasenames = new Set(options.exemptRouteBasenames ?? ['route.ts', 'route.tsx'])
		const filename = context.filename ?? ''

		const check = (node: FunctionNode) => {
			if (
				node.params.length <= maxParams ||
				!_isOwnedFunction(node) ||
				_isExportedHttpRouteHandler({
					filename,
					httpRouteFunctionNames,
					routeBasenames,
					node,
				})
			) {
				return
			}

			context.report({
				node,
				message,
			})
		}

		return {
			FunctionDeclaration: check,
			FunctionExpression: check,
			ArrowFunctionExpression: check,
		}
	},
}

export default rule
