import { defineRule, type ESTree } from '@oxlint/plugins'

import { propertyName } from '../shared/tagged-values.ts'

const isTagProperty = (
	property: ESTree.ObjectProperty | ESTree.PropertyDefinition | ESTree.TSPropertySignature,
): boolean =>
	(property.key.type === 'Identifier' && property.key.name === '_tag') ||
	(property.key.type === 'Literal' && property.key.value === '_tag')

const schemaTagConstructors = new Set(['tag', 'tagDefaultOmit'])

/** `_tag: Schema.tag("A")` and `_tag: Schema.tagDefaultOmit("A")` declare a schema field; they build no value. */
const isSchemaTagField = (property: ESTree.ObjectProperty): boolean =>
	property.value.type === 'CallExpression' &&
	property.value.callee.type === 'MemberExpression' &&
	!property.value.callee.computed &&
	property.value.callee.object.type === 'Identifier' &&
	property.value.callee.object.name === 'Schema' &&
	property.value.callee.property.type === 'Identifier' &&
	schemaTagConstructors.has(property.value.callee.property.name)

export const noManualTaggedConstructionRule = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description:
				'Construct tagged values with their existing Effect constructor instead of writing `_tag` manually.',
		},
		messages: {
			manualConstruction:
				'Use the existing Schema tagged `.make` or tagged class/error constructor instead of writing a literal `_tag` object.',
			manualDeclaration:
				'Declare tagged values with Schema.TaggedStruct, Schema.TaggedClass, Schema.TaggedError, or Schema.TaggedUnion instead of writing a literal `_tag` property.',
		},
	},
	createOnce(context) {
		return {
			ObjectExpression(node) {
				const tag = node.properties.find(
					(property) =>
						property.type === 'Property' &&
						propertyName(property) === '_tag' &&
						!isSchemaTagField(property),
				)
				if (tag !== undefined) {
					context.report({ node: tag, messageId: 'manualConstruction' })
				}
			},
			PropertyDefinition(node) {
				if (isTagProperty(node)) {
					context.report({ node, messageId: 'manualDeclaration' })
				}
			},
			TSPropertySignature(node) {
				if (isTagProperty(node)) {
					context.report({ node, messageId: 'manualDeclaration' })
				}
			},
		}
	},
})
