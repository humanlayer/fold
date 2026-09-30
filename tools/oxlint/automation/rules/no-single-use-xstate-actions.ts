import type { RuleTester } from 'oxlint/plugins-dev'

import {
	collectSetupDefinitions,
	countMachineReferences,
	isNode,
	nodeAt,
	nodeList,
	objectProperty,
	propertyValue,
	setupCallFromCreateMachineCall,
	stringLiteralValue,
} from './xstate-single-use.ts'

type Rule = Parameters<RuleTester['run']>[1]

export const actionReferenceNames = ({ node }: { node: { type: string } }): Array<string> => {
	if (!isNode(node)) {
		return []
	}

	const literalValue = stringLiteralValue({ node })

	if (literalValue !== undefined) {
		return [literalValue]
	}

	if (node.type === 'ArrayExpression') {
		return nodeList({ value: node.elements }).flatMap((element) => actionReferenceNames({ node: element }))
	}

	const typeProperty = objectProperty({ name: 'type', node })
	const typeValue = typeProperty === undefined ? undefined : propertyValue({ node: typeProperty })

	if (typeValue === undefined) {
		return []
	}

	const reference = stringLiteralValue({ node: typeValue })

	return reference === undefined ? [] : [reference]
}

const rule: Rule = {
	meta: {
		type: 'suggestion' as const,
		docs: {
			description: 'Inline custom XState setup actions referenced only once in the machine config.',
		},
	},
	create(context) {
		return {
			CallExpression(node) {
				if (!isNode(node)) {
					return
				}

				const setupCall = setupCallFromCreateMachineCall({ node })

				if (setupCall === undefined) {
					return
				}

				const definitions = collectSetupDefinitions({
					definitionPropertyName: 'actions',
					node: setupCall,
				})

				if (definitions.length === 0) {
					return
				}

				const machineConfig = nodeAt({ index: 0, value: node.arguments })

				if (machineConfig === undefined) {
					return
				}

				const definedNames = new Set(definitions.map((definition) => definition.name))
				const counts = new Map<string, number>()

				countMachineReferences({
					counts,
					definedNames,
					node: machineConfig,
					referenceNames: actionReferenceNames,
					referencePropertyName: 'actions',
				})

				for (const definition of definitions) {
					if ((counts.get(definition.name) ?? 0) !== 1) {
						continue
					}

					context.report({
						node: definition.node,
						message: `Inline the "${definition.name}" XState action at its only usage site instead of defining it in setup actions.`,
					})
				}
			},
		}
	},
}

export default rule
