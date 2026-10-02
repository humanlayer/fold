import type { RuleTester } from 'oxlint/plugins-dev'

import {
	collectSetupDefinitions,
	countMachineReferences,
	isNode,
	nodeAt,
	setupCallFromCreateMachineCall,
	typedReferenceName,
} from './xstate-single-use.ts'

type Rule = Parameters<RuleTester['run']>[1]

const rule: Rule = {
	meta: {
		type: 'suggestion' as const,
		docs: {
			description: 'Inline custom XState setup guards referenced only once in the machine config.',
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
					definitionPropertyName: 'guards',
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
					referenceNames: ({ node: guard }) => {
						const reference = typedReferenceName({ node: guard })

						return reference === undefined ? [] : [reference]
					},
					referencePropertyName: 'guard',
				})

				for (const definition of definitions) {
					if ((counts.get(definition.name) ?? 0) !== 1) {
						continue
					}

					context.report({
						node: definition.node,
						message: `Inline the "${definition.name}" XState guard at its only usage site instead of defining it in setup guards.`,
					})
				}
			},
		}
	},
}

export default rule
