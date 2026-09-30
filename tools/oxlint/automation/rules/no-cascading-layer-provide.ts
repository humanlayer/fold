import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type CallExpressionNode = Parameters<NonNullable<VisitorObject['CallExpression']>>[0]
type IdentifierNode = Extract<CallExpressionNode['callee'], { type: 'Identifier' }>

const provisioningMethods = new Set(['provide', 'provideMerge'])

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description:
				'Combine independent Layer dependencies in one provide call and extract intentional dependency stages.',
		},
	},
	create(context) {
		const findImportDefinition = ({ node }: { node: IdentifierNode }) => {
			let scope: ReturnType<typeof context.sourceCode.getScope> | null = context.sourceCode.getScope(node)

			while (scope !== null) {
				const variable = scope.set.get(node.name)

				if (variable !== undefined) {
					return variable.defs.find(
						(definition) =>
							definition.type === 'ImportBinding' && definition.parent?.type === 'ImportDeclaration',
					)
				}

				scope = scope.upper
			}

			return undefined
		}

		const isEffectLayerIdentifier = ({ node }: { node: IdentifierNode }) => {
			const definition = findImportDefinition({ node })

			return (
				definition?.parent?.type === 'ImportDeclaration' &&
				definition.parent.source.value === 'effect' &&
				definition.node.type === 'ImportSpecifier' &&
				(definition.node.imported.type === 'Identifier'
					? definition.node.imported.name
					: definition.node.imported.value) === 'Layer'
			)
		}

		const isLayerProvision = ({ node }: { node: CallExpressionNode['arguments'][number] }) => {
			if (
				node.type !== 'CallExpression' ||
				node.callee.type !== 'MemberExpression' ||
				node.callee.object.type !== 'Identifier' ||
				!isEffectLayerIdentifier({ node: node.callee.object })
			) {
				return false
			}

			const property = node.callee.property
			const propertyName =
				property.type === 'Identifier'
					? property.name
					: property.type === 'Literal' && typeof property.value === 'string'
						? property.value
						: undefined

			return provisioningMethods.has(propertyName ?? '')
		}

		return {
			CallExpression(node) {
				if (
					node.callee.type !== 'MemberExpression' ||
					node.callee.property.type !== 'Identifier' ||
					node.callee.property.name !== 'pipe'
				) {
					return
				}

				const provisioningStages = node.arguments.filter((argument) => isLayerProvision({ node: argument }))

				if (provisioningStages.length < 2) {
					return
				}

				context.report({
					node,
					message:
						'Avoid multiple Layer.provide or Layer.provideMerge stages in one pipe. Combine independent dependencies in one Layer.provide([...]); when a layer depends on another layer, extract and name that configured layer before providing it.',
				})
			},
		}
	},
}

export default rule
