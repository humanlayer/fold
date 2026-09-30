type Node = {
	[key: string]: unknown
	type: string
}

type ReportNode = Node & { range: [number, number] }

export type Definition = {
	name: string
	node: ReportNode
}

export type ReferenceNames = ({ node }: { node: Node }) => Array<string>

export const isNode = (value: unknown): value is Node =>
	typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

export const isReportNode = (value: unknown): value is ReportNode =>
	isNode(value) &&
	'range' in value &&
	Array.isArray(value.range) &&
	value.range.length === 2 &&
	typeof value.range[0] === 'number' &&
	typeof value.range[1] === 'number'

export const nodeList = ({ value }: { value: unknown }) => (Array.isArray(value) ? value.filter(isNode) : [])

export const nodeAt = ({ index, value }: { index: number; value: unknown }) =>
	Array.isArray(value) && isNode(value[index]) ? value[index] : undefined

const nodeField = ({ field, node }: { field: string; node: Node }) => (isNode(node[field]) ? node[field] : undefined)

export const propertyName = ({ node }: { node: Node }) => {
	const key = nodeField({ field: 'key', node })

	if (key?.type === 'Identifier' && typeof key.name === 'string') {
		return key.name
	}

	if (typeof key?.value === 'string') {
		return key.value
	}

	const property = nodeField({ field: 'property', node })

	if (property?.type === 'Identifier' && typeof property.name === 'string') {
		return property.name
	}

	if (typeof property?.value === 'string') {
		return property.value
	}

	return undefined
}

export const propertyValue = ({ node }: { node: Node }) => nodeField({ field: 'value', node })

export const stringLiteralValue = ({ node }: { node: Node }) =>
	typeof node.value === 'string' ? node.value : undefined

export const objectProperty = ({ name, node }: { name: string; node: Node }) => {
	if (node.type !== 'ObjectExpression') {
		return undefined
	}

	return nodeList({ value: node.properties }).find((property) => propertyName({ node: property }) === name)
}

export const collectSetupDefinitions = ({
	definitionPropertyName,
	node,
}: {
	definitionPropertyName: string
	node: Node
}) => {
	const setupOptions = nodeAt({ index: 0, value: node.arguments })

	if (setupOptions === undefined) {
		return []
	}

	const definitionsProperty = objectProperty({
		name: definitionPropertyName,
		node: setupOptions,
	})
	const definitionsObject =
		definitionsProperty === undefined ? undefined : propertyValue({ node: definitionsProperty })

	if (definitionsObject?.type !== 'ObjectExpression') {
		return []
	}

	return nodeList({ value: definitionsObject.properties }).flatMap((property): Array<Definition> => {
		const name = propertyName({ node: property })

		return name !== undefined && isReportNode(property) ? [{ name, node: property }] : []
	})
}

export const typedReferenceName = ({ node }: { node: Node }) => {
	const literalValue = stringLiteralValue({ node })

	if (literalValue !== undefined) {
		return literalValue
	}

	const typeProperty = objectProperty({ name: 'type', node })
	const typeValue = typeProperty === undefined ? undefined : propertyValue({ node: typeProperty })

	return typeValue === undefined ? undefined : stringLiteralValue({ node: typeValue })
}

export const countMachineReferences = ({
	counts,
	definedNames,
	node,
	referenceNames,
	referencePropertyName,
}: {
	counts: Map<string, number>
	definedNames: Set<string>
	node: Node
	referenceNames: ReferenceNames
	referencePropertyName: string
}) => {
	if (node.type === 'ObjectExpression') {
		for (const property of nodeList({ value: node.properties })) {
			const value = propertyValue({ node: property })

			if (propertyName({ node: property }) === referencePropertyName) {
				if (value !== undefined) {
					for (const name of referenceNames({ node: value })) {
						if (definedNames.has(name)) {
							counts.set(name, (counts.get(name) ?? 0) + 1)
						}
					}
				}

				continue
			}

			if (value !== undefined) {
				countMachineReferences({
					counts,
					definedNames,
					node: value,
					referenceNames,
					referencePropertyName,
				})
			}
		}
	}

	if (node.type === 'ArrayExpression') {
		for (const element of nodeList({ value: node.elements })) {
			countMachineReferences({
				counts,
				definedNames,
				node: element,
				referenceNames,
				referencePropertyName,
			})
		}
	}
}

export const setupCallFromCreateMachineCall = ({ node }: { node: Node }) => {
	const callee = nodeField({ field: 'callee', node })
	const setupCall = nodeField({ field: 'object', node: callee ?? node })
	const setupCallee = setupCall === undefined ? undefined : nodeField({ field: 'callee', node: setupCall })

	if (
		callee?.type !== 'MemberExpression' ||
		propertyName({ node: callee }) !== 'createMachine' ||
		setupCall?.type !== 'CallExpression' ||
		setupCallee?.type !== 'Identifier' ||
		setupCallee.name !== 'setup'
	) {
		return undefined
	}

	return setupCall
}
