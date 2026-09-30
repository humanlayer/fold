import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type NodeLike = {
	type: string
	key?: NodeLike
	name?: unknown
	value?: unknown
	parent?: NodeLike | null
	callee?: NodeLike
}

const message = 'Avoid type assertions. Prefer typed construction, validation, or inference.'

const propertyName = (node: NodeLike) =>
	(node.type === 'Identifier' || node.type === 'PrivateIdentifier') && typeof node.name === 'string'
		? node.name
		: node.type === 'StringLiteral' && typeof node.value === 'string'
			? node.value
			: undefined

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid TypeScript type assertions; prefer typed construction, validation, or inference.',
		},
	},
	create(context) {
		return {
			TSAsExpression(node) {
				if (
					node.typeAnnotation.type === 'TSTypeReference' &&
					node.typeAnnotation.typeName?.type === 'Identifier' &&
					node.typeAnnotation.typeName.name === 'const'
				) {
					return
				}

				const typedProperty = node.parent
				const typedKey =
					typedProperty?.type === 'Property' && typedProperty.key
						? propertyName(typedProperty.key)
						: undefined
				const typesProperty = typedProperty?.parent?.parent
				const setupCall = typesProperty?.parent?.parent
				const property = node.parent?.type === 'TSSatisfiesExpression' ? node.parent.parent : node.parent
				const call = property?.parent?.parent
				const isSetupTypeAssertion =
					typedProperty?.type === 'Property' &&
					(typedKey === 'input' ||
						typedKey === 'events' ||
						typedKey === 'context' ||
						typedKey === 'children' ||
						typedKey === 'output') &&
					typedProperty.parent?.type === 'ObjectExpression' &&
					typesProperty?.type === 'Property' &&
					typesProperty.key !== undefined &&
					propertyName(typesProperty.key) === 'types' &&
					typesProperty.parent?.type === 'ObjectExpression' &&
					setupCall?.type === 'CallExpression' &&
					setupCall.callee?.type === 'Identifier' &&
					setupCall.callee.name === 'setup'
				const isCreateStoreContextAssertion =
					property?.type === 'Property' &&
					property.key !== undefined &&
					propertyName(property.key) === 'context' &&
					property.parent?.type === 'ObjectExpression' &&
					call?.type === 'CallExpression' &&
					call.callee?.type === 'Identifier' &&
					call.callee.name === 'createStore'

				if (isSetupTypeAssertion || isCreateStoreContextAssertion) {
					return
				}

				context.report({
					node,
					message,
				})
			},
			TSTypeAssertion(node) {
				context.report({
					node,
					message,
				})
			},
		}
	},
}

export default rule
