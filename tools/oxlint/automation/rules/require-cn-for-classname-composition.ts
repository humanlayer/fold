import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type JSXAttributeNode = Parameters<NonNullable<VisitorObject['JSXAttribute']>>[0]
type IdentifierNode = Parameters<NonNullable<VisitorObject['Identifier']>>[0]
type IfStatementNode = Parameters<NonNullable<VisitorObject['IfStatement']>>[0]
type ReturnStatementNode = Parameters<NonNullable<VisitorObject['ReturnStatement']>>[0]
type ExpressionNode = NonNullable<ReturnStatementNode['argument']>

interface Options {
	readonly ignoredPathMarkers?: ReadonlyArray<string>
	readonly utilityModules?: ReadonlyArray<string>
	readonly utilityName?: string
}

const literalExpressionTypes = new Set([
	'BigIntLiteral',
	'BooleanLiteral',
	'Literal',
	'NullLiteral',
	'NumericLiteral',
	'RegExpLiteral',
	'StringLiteral',
])

const message = 'Compose conditional or combined className values with cn from the approved shared utility.'

const _isClassNameAttribute = ({ node }: { node: JSXAttributeNode }) =>
	node.name.type === 'JSXIdentifier' && (node.name.name === 'className' || node.name.name.endsWith('ClassName'))

const _unwrapExpression = ({ node }: { node: ExpressionNode }): ExpressionNode => {
	if (
		node.type === 'ChainExpression' ||
		node.type === 'ParenthesizedExpression' ||
		node.type === 'TSAsExpression' ||
		node.type === 'TSInstantiationExpression' ||
		node.type === 'TSNonNullExpression' ||
		node.type === 'TSSatisfiesExpression' ||
		node.type === 'TSTypeAssertion'
	) {
		return _unwrapExpression({ node: node.expression })
	}

	return node
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Require dynamic JSX class name composition to use the approved cn utility.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					ignoredPathMarkers: {
						type: 'array',
						items: { type: 'string' },
					},
					utilityModules: {
						type: 'array',
						items: { type: 'string' },
					},
					utilityName: { type: 'string' },
				},
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const options = (context.options[0] ?? {}) as Options
		const ignoredPathMarkers = options.ignoredPathMarkers ?? ['/native/']
		const utilityModules = options.utilityModules ?? ['@scope/ui-utils']
		const utilityName = options.utilityName ?? 'cn'

		if (!filename.endsWith('.tsx') || ignoredPathMarkers.some((marker) => filename.includes(marker))) {
			return {}
		}

		const reportedAttributes = new Set<number>()
		const conditionalCallbackAttributes = new Set<number>()
		const isApprovedCnSource = ({ source }: { source: string }) => utilityModules.includes(source)

		const findVariable = ({ node }: { node: IdentifierNode }) => {
			let scope: ReturnType<typeof context.sourceCode.getScope> | null = context.sourceCode.getScope(node)

			while (scope !== null) {
				const variable = scope.set.get(node.name)

				if (variable !== undefined) {
					return variable
				}

				scope = scope.upper
			}

			return undefined
		}

		const findImportDefinition = ({ node }: { node: IdentifierNode }) =>
			findVariable({ node })?.defs.find(
				(definition) => definition.type === 'ImportBinding' && definition.parent?.type === 'ImportDeclaration',
			)

		const isApprovedCnIdentifier = ({ node }: { node: IdentifierNode }) => {
			const definition = findImportDefinition({ node })

			return (
				definition !== undefined &&
				definition.parent?.type === 'ImportDeclaration' &&
				isApprovedCnSource({ source: definition.parent.source.value }) &&
				definition.node.type === 'ImportSpecifier' &&
				(definition.node.imported.type === 'Identifier'
					? definition.node.imported.name
					: definition.node.imported.value) === utilityName
			)
		}

		const isNextFontFactory = ({ node }: { node: IdentifierNode }) => {
			const definition = findImportDefinition({ node })

			if (definition === undefined || definition.parent?.type !== 'ImportDeclaration') {
				return false
			}

			const source = definition.parent.source.value

			return (
				(source === 'next/font/local' && definition.node.type === 'ImportDefaultSpecifier') ||
				(source === 'next/font/google' && definition.node.type === 'ImportSpecifier')
			)
		}

		const isNextFontValue = ({ node }: { node: IdentifierNode }) => {
			const variable = findVariable({ node })

			return (
				variable?.defs.some((definition) => {
					if (
						definition.type !== 'Variable' ||
						definition.node.type !== 'VariableDeclarator' ||
						definition.node.init?.type !== 'CallExpression' ||
						definition.node.init.callee.type !== 'Identifier'
					) {
						return false
					}

					return isNextFontFactory({
						node: definition.node.init.callee,
					})
				}) === true
			)
		}

		const isNextFontTemplate = ({ node }: { node: Extract<ExpressionNode, { type: 'TemplateLiteral' }> }) =>
			node.expressions.length > 0 &&
			node.quasis.every((quasi) => quasi.value.raw.trim().length === 0) &&
			node.expressions.every((expression) => {
				const value = _unwrapExpression({ node: expression })

				return (
					value.type === 'MemberExpression' &&
					value.computed === false &&
					value.object.type === 'Identifier' &&
					value.property.type === 'Identifier' &&
					(value.property.name === 'className' || value.property.name === 'variable') &&
					isNextFontValue({ node: value.object })
				)
			})

		const findVariableDefinition = ({ node }: { node: IdentifierNode }) =>
			findVariable({ node })?.defs.find(
				(definition) => definition.type === 'Variable' && definition.node.type === 'VariableDeclarator',
			)

		const resolveConstInitializer = ({ node }: { node: IdentifierNode }) => {
			const definition = findVariableDefinition({ node })

			if (
				definition?.node.type !== 'VariableDeclarator' ||
				definition.node.parent?.type !== 'VariableDeclaration' ||
				definition.node.parent.kind !== 'const' ||
				definition.node.init === null
			) {
				return undefined
			}

			return definition.node.init
		}

		const isAllowedExpression = ({
			node,
			visited,
		}: {
			node: ExpressionNode
			visited: Set<ExpressionNode>
		}): boolean => {
			const value = _unwrapExpression({ node })

			if (visited.has(value)) {
				return true
			}

			visited.add(value)

			if (literalExpressionTypes.has(value.type)) {
				return true
			}

			if (value.type === 'Identifier') {
				const definition = findVariableDefinition({ node: value })

				if (definition !== undefined) {
					const initializer = resolveConstInitializer({ node: value })

					return initializer !== undefined && isAllowedExpression({ node: initializer, visited })
				}

				return true
			}

			if (value.type === 'MemberExpression') {
				return true
			}

			if (value.type === 'TemplateLiteral') {
				return value.expressions.length === 0 || isNextFontTemplate({ node: value })
			}

			if (value.type === 'CallExpression') {
				return value.callee.type === 'Identifier' && isApprovedCnIdentifier({ node: value.callee })
			}

			if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') {
				if (value.body === null) {
					return false
				}

				return value.body.type === 'BlockStatement' ? true : isAllowedExpression({ node: value.body, visited })
			}

			return false
		}

		const isCnComposition = ({
			node,
			visited,
		}: {
			node: ExpressionNode
			visited: Set<ExpressionNode>
		}): boolean => {
			const value = _unwrapExpression({ node })

			if (visited.has(value)) {
				return false
			}

			visited.add(value)

			if (value.type === 'CallExpression') {
				return value.callee.type === 'Identifier' && isApprovedCnIdentifier({ node: value.callee })
			}

			if (value.type !== 'Identifier') {
				return false
			}

			const initializer = resolveConstInitializer({ node: value })

			return initializer !== undefined && isCnComposition({ node: initializer, visited })
		}

		const report = ({ node }: { node: JSXAttributeNode }) => {
			if (reportedAttributes.has(node.range[0])) {
				return
			}

			reportedAttributes.add(node.range[0])
			context.report({
				node,
				message,
			})
		}

		const enclosingClassNameAttribute = ({ node }: { node: IfStatementNode | ReturnStatementNode }) => {
			let current: IfStatementNode['parent'] | null = node.parent

			while (
				current !== null &&
				current.type !== 'ArrowFunctionExpression' &&
				current.type !== 'FunctionExpression'
			) {
				current = current.parent
			}

			if (
				current === null ||
				current.parent?.type !== 'JSXExpressionContainer' ||
				current.parent.parent?.type !== 'JSXAttribute' ||
				!_isClassNameAttribute({ node: current.parent.parent })
			) {
				return undefined
			}

			return current.parent.parent
		}

		return {
			IfStatement(node) {
				const attribute = enclosingClassNameAttribute({ node })

				if (attribute !== undefined) {
					conditionalCallbackAttributes.add(attribute.range[0])
				}
			},
			JSXAttribute(node) {
				if (
					!_isClassNameAttribute({ node }) ||
					node.value?.type !== 'JSXExpressionContainer' ||
					node.value.expression.type === 'JSXEmptyExpression'
				) {
					return
				}

				const expression = _unwrapExpression({
					node: node.value.expression,
				})

				if (
					(expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression') &&
					expression.body !== null &&
					expression.body.type === 'BlockStatement'
				) {
					return
				}

				if (
					!isAllowedExpression({
						node: expression,
						visited: new Set(),
					})
				) {
					report({ node })
				}
			},
			ReturnStatement(node) {
				if (node.argument === null) {
					return
				}

				const enclosingAttribute = enclosingClassNameAttribute({ node })

				if (
					enclosingAttribute !== undefined &&
					((conditionalCallbackAttributes.has(enclosingAttribute.range[0]) &&
						!isCnComposition({
							node: node.argument,
							visited: new Set(),
						})) ||
						!isAllowedExpression({
							node: node.argument,
							visited: new Set(),
						}))
				) {
					report({ node: enclosingAttribute })
				}
			},
		}
	},
}

export default rule
