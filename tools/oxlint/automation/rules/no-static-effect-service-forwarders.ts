import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type CallExpressionNode = Parameters<NonNullable<VisitorObject['CallExpression']>>[0]
type ImportDeclarationNode = Parameters<NonNullable<VisitorObject['ImportDeclaration']>>[0]
type IdentifierNode = Parameters<NonNullable<VisitorObject['Identifier']>>[0]
type CallbackExpression = {
	expression: unknown
	parameterName: string | undefined
}

const message =
	'Do not expose an Effect service method through a static forwarder. Yield the service at the usage site and call the method directly.'

const _nodeName = ({ node }: { node: unknown }) =>
	typeof node === 'object' && node !== null && 'name' in node && typeof node.name === 'string' ? node.name : undefined

const _isCallExpressionNode = (node: unknown): node is CallExpressionNode =>
	typeof node === 'object' && node !== null && 'type' in node && node.type === 'CallExpression'

const _isIdentifierNode = (node: unknown): node is IdentifierNode =>
	typeof node === 'object' && node !== null && 'type' in node && node.type === 'Identifier'

const _importedName = ({ specifier }: { specifier: ImportDeclarationNode['specifiers'][number] }) =>
	specifier.type === 'ImportSpecifier' ? _nodeName({ node: specifier.imported }) : undefined

const _isStaticClassField = ({ node }: { node: CallExpressionNode }) => {
	let current: unknown = node.parent

	while (typeof current === 'object' && current !== null && 'type' in current) {
		if (current.type === 'PropertyDefinition') {
			return 'static' in current && current.static === true
		}

		if (current.type === 'Program') {
			return false
		}

		current = 'parent' in current ? current.parent : undefined
	}

	return false
}

const _callbackExpression = ({ node }: { node: unknown }): CallbackExpression | undefined => {
	if (typeof node !== 'object' || node === null || !('type' in node)) {
		return undefined
	}

	if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') {
		return undefined
	}

	if (!('params' in node) || !Array.isArray(node.params)) {
		return undefined
	}

	const [parameter] = node.params
	if (
		node.params.length !== 1 ||
		typeof parameter !== 'object' ||
		parameter === null ||
		!('type' in parameter) ||
		parameter.type !== 'Identifier'
	) {
		return undefined
	}

	if (!('body' in node) || typeof node.body !== 'object' || node.body === null) {
		return undefined
	}

	if (!('type' in node.body) || node.body.type !== 'BlockStatement') {
		return {
			expression: node.body,
			parameterName: _nodeName({ node: parameter }),
		}
	}

	if (!('body' in node.body) || !Array.isArray(node.body.body)) {
		return undefined
	}

	const [statement] = node.body.body
	if (
		node.body.body.length !== 1 ||
		typeof statement !== 'object' ||
		statement === null ||
		!('type' in statement) ||
		statement.type !== 'ReturnStatement' ||
		!('argument' in statement)
	) {
		return undefined
	}

	return {
		expression: statement.argument,
		parameterName: _nodeName({ node: parameter }),
	}
}

const _isDirectParameterMember = ({
	expression,
	parameterName,
}: {
	expression: unknown
	parameterName: string | undefined
}) => {
	if (
		parameterName === undefined ||
		typeof expression !== 'object' ||
		expression === null ||
		!('type' in expression)
	) {
		return false
	}

	const member =
		expression.type === 'CallExpression' &&
		'callee' in expression &&
		typeof expression.callee === 'object' &&
		expression.callee !== null
			? expression.callee
			: expression

	return (
		'type' in member &&
		member.type === 'MemberExpression' &&
		'object' in member &&
		typeof member.object === 'object' &&
		member.object !== null &&
		'type' in member.object &&
		member.object.type === 'Identifier' &&
		_nodeName({ node: member.object }) === parameterName
	)
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description:
				'Disallow static Effect service method forwarders; acquire the service where its method is used.',
		},
	},
	create(context) {
		const effectNamespaceNames = new Set<string>()
		const flatMapNames = new Set<string>()
		const serviceNames = new Set<string>()
		const pipeNames = new Set<string>()

		const isImportedIdentifier = ({ names, node }: { names: ReadonlySet<string>; node: IdentifierNode }) => {
			if (!names.has(node.name)) {
				return false
			}

			let scope: ReturnType<typeof context.sourceCode.getScope> | null = context.sourceCode.getScope(node)

			while (scope !== null) {
				const variable = scope.set.get(node.name)
				if (variable !== undefined) {
					return variable.defs.some((definition) => definition.type === 'ImportBinding')
				}

				scope = scope.upper
			}

			return false
		}

		const effectCall = ({
			name,
			names,
			node,
		}: {
			name: 'flatMap' | 'service'
			names: ReadonlySet<string>
			node: unknown
		}): CallExpressionNode | undefined => {
			if (!_isCallExpressionNode(node)) {
				return undefined
			}

			if (_isIdentifierNode(node.callee)) {
				return isImportedIdentifier({
					names,
					node: node.callee,
				})
					? node
					: undefined
			}

			return node.callee.type === 'MemberExpression' &&
				_isIdentifierNode(node.callee.object) &&
				isImportedIdentifier({
					names: effectNamespaceNames,
					node: node.callee.object,
				}) &&
				_nodeName({ node: node.callee.property }) === name
				? node
				: undefined
		}

		const isServiceThisCall = ({ node }: { node: unknown }) => {
			const call = effectCall({ name: 'service', names: serviceNames, node })
			return call !== undefined && call.arguments.length === 1 && call.arguments[0]?.type === 'ThisExpression'
		}

		const isForwardingFlatMap = ({ node }: { node: unknown }) => {
			const call = effectCall({ name: 'flatMap', names: flatMapNames, node })
			if (call === undefined) {
				return false
			}

			const callback = _callbackExpression({ node: call.arguments.at(-1) })
			return callback !== undefined && _isDirectParameterMember(callback)
		}

		const isPipeCall = ({ node }: { node: CallExpressionNode }) => {
			if (node.callee.type === 'Identifier') {
				return isImportedIdentifier({
					names: pipeNames,
					node: node.callee,
				})
			}

			return node.callee.type === 'MemberExpression' && _nodeName({ node: node.callee.property }) === 'pipe'
		}

		return {
			ImportDeclaration(node) {
				if (node.source.value === 'effect') {
					for (const specifier of node.specifiers) {
						if (specifier.type === 'ImportSpecifier' && _importedName({ specifier }) === 'Effect') {
							effectNamespaceNames.add(specifier.local.name)
						}

						if (specifier.type === 'ImportSpecifier' && _importedName({ specifier }) === 'pipe') {
							pipeNames.add(specifier.local.name)
						}
					}
					return
				}

				if (node.source.value !== 'effect/Effect') {
					return
				}

				for (const specifier of node.specifiers) {
					if (specifier.type === 'ImportNamespaceSpecifier') {
						effectNamespaceNames.add(specifier.local.name)
						continue
					}

					const importedName = _importedName({ specifier })
					if (importedName === 'flatMap') {
						flatMapNames.add(specifier.local.name)
					} else if (importedName === 'service') {
						serviceNames.add(specifier.local.name)
					}
				}
			},
			CallExpression(node) {
				if (!_isStaticClassField({ node })) {
					return
				}

				if (
					effectCall({ name: 'flatMap', names: flatMapNames, node }) !== undefined &&
					node.arguments.length >= 2 &&
					isServiceThisCall({ node: node.arguments[0] }) &&
					isForwardingFlatMap({ node })
				) {
					context.report({ message, node })
					return
				}

				if (!isPipeCall({ node })) {
					return
				}

				const pipedEffect = node.callee.type === 'MemberExpression' ? node.callee.object : node.arguments[0]
				const operators = node.callee.type === 'MemberExpression' ? node.arguments : node.arguments.slice(1)

				if (
					isServiceThisCall({ node: pipedEffect }) &&
					operators.some((operator) => isForwardingFlatMap({ node: operator }))
				) {
					context.report({ message, node })
				}
			},
		}
	},
}

export default rule
