import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

type Node = {
	arguments?: unknown
	body?: unknown
	callee?: unknown
	declaration?: unknown
	declarations?: unknown
	expression?: unknown
	id?: unknown
	init?: unknown
	local?: unknown
	name?: unknown
	object?: unknown
	parent?: Node | null
	property?: unknown
	source?: unknown
	specifiers?: unknown
	type: string
	value?: unknown
}

type CandidateKind = 'effect-function' | 'effect-program' | 'function' | 'type'

type ReferenceLike = {
	identifier: Node
	isRead: () => boolean
}

const functionExpressionTypes = new Set(['ArrowFunctionExpression', 'FunctionExpression'])

const isNode = (value: unknown): value is Node =>
	typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

const nodeList = ({ value }: { value: unknown }) => (Array.isArray(value) ? value.filter(isNode) : [])

const nodeField = ({ field, node }: { field: keyof Node; node: Node }) =>
	isNode(node[field]) ? node[field] : undefined

const isFunctionExpression = ({ node }: { node: unknown }) => isNode(node) && functionExpressionTypes.has(node.type)

const isPascalCase = ({ name }: { name: string }) => /^[A-Z]/.test(name)

const memberPropertyName = ({ node }: { node: Node }) => {
	const property = nodeField({ field: 'property', node })

	if (property?.type === 'Identifier' && typeof property.name === 'string') {
		return property.name
	}

	if (typeof property?.value === 'string') {
		return property.value
	}

	return undefined
}

const effectCalleeName = ({ node }: { node: Node }) => {
	const object = nodeField({ field: 'object', node })

	if (node.type !== 'MemberExpression' || object?.type !== 'Identifier' || object.name !== 'Effect') {
		return undefined
	}

	return memberPropertyName({ node })
}

const isEffectCall = ({ name, node }: { name: 'fn' | 'fnUntraced' | 'gen'; node: unknown }) =>
	isNode(node) &&
	node.type === 'CallExpression' &&
	effectCalleeName({ node: nodeField({ field: 'callee', node }) ?? node }) === name

const isEffectFunctionInitializer = ({ node }: { node: unknown }) =>
	isEffectCall({ name: 'fnUntraced', node }) ||
	isEffectCall({ name: 'fn', node }) ||
	(isNode(node) &&
		node.type === 'CallExpression' &&
		isEffectCall({ name: 'fn', node: nodeField({ field: 'callee', node }) }))

const isEffectProgramInitializer = ({ node }: { node: unknown }) => isEffectCall({ name: 'gen', node })

const topLevelVariableKind = ({ node }: { node: Node }): CandidateKind | undefined => {
	const id = nodeField({ field: 'id', node })

	if (
		id?.type !== 'Identifier' ||
		node.parent?.type !== 'VariableDeclaration' ||
		node.parent.parent?.type !== 'Program'
	) {
		return undefined
	}

	if (isFunctionExpression({ node: node.init })) {
		return 'function'
	}

	if (isEffectFunctionInitializer({ node: node.init })) {
		return 'effect-function'
	}

	if (isEffectProgramInitializer({ node: node.init })) {
		return 'effect-program'
	}

	return undefined
}

const addIdentifierName = ({ names, node }: { names: Set<string>; node: unknown }) => {
	if (isNode(node) && node.type === 'Identifier' && typeof node.name === 'string') {
		names.add(node.name)
	}
}

const addDeclarationNames = ({ declaration, names }: { declaration: unknown; names: Set<string> }) => {
	if (!isNode(declaration)) {
		return
	}

	if (declaration.type === 'FunctionDeclaration') {
		addIdentifierName({
			names,
			node: nodeField({ field: 'id', node: declaration }),
		})
		return
	}

	if (declaration.type === 'VariableDeclaration') {
		for (const variable of nodeList({ value: declaration.declarations })) {
			addIdentifierName({
				names,
				node: nodeField({ field: 'id', node: variable }),
			})
		}
	}

	if (declaration.type === 'TSTypeAliasDeclaration' || declaration.type === 'TSInterfaceDeclaration') {
		addIdentifierName({
			names,
			node: nodeField({ field: 'id', node: declaration }),
		})
	}
}

const exportedNames = ({ node }: { node: Node }) => {
	const names = new Set<string>()

	for (const statement of nodeList({ value: node.body })) {
		if (statement.type === 'ExportDefaultDeclaration') {
			const declaration = nodeField({ field: 'declaration', node: statement })

			addIdentifierName({ names, node: declaration })
			addIdentifierName({
				names,
				node: declaration === undefined ? undefined : nodeField({ field: 'id', node: declaration }),
			})
		}

		if (statement.type === 'ExportNamedDeclaration') {
			addDeclarationNames({ declaration: statement.declaration, names })

			if (statement.source === null || statement.source === undefined) {
				for (const specifier of nodeList({ value: statement.specifiers })) {
					addIdentifierName({
						names,
						node: nodeField({ field: 'local', node: specifier }),
					})
				}
			}
		}

		if (statement.type === 'TSExportAssignment') {
			addIdentifierName({ names, node: statement.expression })
		}
	}

	return names
}

const hasTypeAncestor = ({ node }: { node: Node }) => {
	let current = node.parent

	while (current !== undefined && current !== null) {
		if (current.type.startsWith('TS')) {
			return true
		}

		if (current.type === 'Program' || current.type === 'BlockStatement' || current.type === 'ExpressionStatement') {
			return false
		}

		current = current.parent
	}

	return false
}

const hasExportAncestor = ({ node }: { node: Node }) => {
	let current = node.parent

	while (current !== undefined && current !== null) {
		if (
			current.type === 'ExportDefaultDeclaration' ||
			current.type === 'ExportSpecifier' ||
			current.type === 'TSExportAssignment'
		) {
			return true
		}

		if (current.type === 'Program' || current.type === 'BlockStatement') {
			return false
		}

		current = current.parent
	}

	return false
}

const isRuntimeReadReference = ({ reference }: { reference: ReferenceLike }) =>
	reference.isRead() &&
	!hasTypeAncestor({ node: reference.identifier }) &&
	!hasExportAncestor({ node: reference.identifier })

const runtimeReadCount = ({ references }: { references: Array<ReferenceLike> }) =>
	references.filter((reference) => isRuntimeReadReference({ reference })).length

const isTypeReadReference = ({ reference }: { reference: ReferenceLike }) =>
	reference.isRead() &&
	hasTypeAncestor({ node: reference.identifier }) &&
	!hasExportAncestor({ node: reference.identifier })

const typeReadCount = ({ references }: { references: Array<ReferenceLike> }) =>
	references.filter((reference) => isTypeReadReference({ reference })).length

const singleUseCount = ({
	candidate,
}: {
	candidate: {
		kind: CandidateKind
		variable: {
			references: Array<ReferenceLike>
		}
	}
}) =>
	candidate.kind === 'type'
		? typeReadCount({ references: candidate.variable.references })
		: runtimeReadCount({ references: candidate.variable.references })

const message = ({ kind, name }: { kind: CandidateKind; name: string }) => {
	if (kind === 'effect-function') {
		return `Inline the private Effect function "${name}" at its only usage site instead of defining it as a top-level function.`
	}

	if (kind === 'effect-program') {
		return `Inline the private Effect program "${name}" at its only usage site instead of defining it as a top-level value.`
	}

	if (kind === 'type') {
		return `Inline the private type "${name}" at its only usage site instead of defining it as a top-level type.`
	}

	return `Inline the private function "${name}" at its only usage site instead of defining it as a top-level function.`
}

const rule: Rule = {
	meta: {
		type: 'suggestion' as const,
		docs: {
			description: 'Inline private top-level functions, Effect values, and types referenced only once.',
		},
	},
	create(context) {
		return {
			Program(node) {
				type SourceNode = Parameters<typeof context.sourceCode.getDeclaredVariables>[0]
				type ScopeVariable = ReturnType<typeof context.sourceCode.getDeclaredVariables>[number]
				type Candidate = {
					kind: CandidateKind
					name: string
					node: SourceNode
					variable: ScopeVariable
				}

				const exported = exportedNames({ node })
				const candidates = node.body.flatMap((statement): Array<Candidate> => {
					if (statement.type === 'FunctionDeclaration') {
						const name = statement.id?.name

						if (name === undefined || isPascalCase({ name }) || exported.has(name)) {
							return []
						}

						const variable = context.sourceCode
							.getDeclaredVariables(statement)
							.find((item) => item.name === name)

						return variable === undefined ? [] : [{ kind: 'function', name, node: statement, variable }]
					}

					if (statement.type === 'TSTypeAliasDeclaration' || statement.type === 'TSInterfaceDeclaration') {
						const name = statement.id.name

						if (exported.has(name)) {
							return []
						}

						const variable = context.sourceCode
							.getDeclaredVariables(statement)
							.find((item) => item.name === name)

						return variable === undefined ? [] : [{ kind: 'type', name, node: statement, variable }]
					}

					if (statement.type === 'VariableDeclaration') {
						return statement.declarations.flatMap((declaration): Array<Candidate> => {
							const name = declaration.id.type === 'Identifier' ? declaration.id.name : undefined
							const kind = topLevelVariableKind({ node: declaration })

							if (
								name === undefined ||
								kind === undefined ||
								isPascalCase({ name }) ||
								exported.has(name)
							) {
								return []
							}

							const variable = context.sourceCode
								.getDeclaredVariables(declaration)
								.find((item) => item.name === name)

							return variable === undefined ? [] : [{ kind, name, node: declaration, variable }]
						})
					}

					return []
				})

				for (const candidate of candidates) {
					if (singleUseCount({ candidate }) !== 1) {
						continue
					}

					context.report({
						node: candidate.node,
						message: message({
							kind: candidate.kind,
							name: candidate.name,
						}),
					})
				}
			},
		}
	},
}

export default rule
