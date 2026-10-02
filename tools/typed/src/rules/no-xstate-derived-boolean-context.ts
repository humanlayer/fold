import * as ts from 'typescript-compiler'

import type { RuleContext, TypedRule } from '../rule.js'

type XstateImports = ReadonlyMap<string, string>

type ContextField = {
	readonly contextType: ts.Type
	readonly declaration?: ts.Declaration
	readonly name: string
}

type MachineContext = {
	readonly assignedFields: ReadonlySet<string>
	readonly fields: ReadonlyMap<string, ContextField>
	readonly guardFields: ReadonlySet<string>
	readonly machineConfig: ts.ObjectLiteralExpression
	readonly snapshotFields: ReadonlySet<string>
}

const _booleanTypeName = 'boolean'

const _isStringLiteralLike = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
	ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)

const _propertyName = ({ name }: { name: ts.PropertyName }) => {
	if (ts.isIdentifier(name) || _isStringLiteralLike(name)) {
		return name.text
	}

	return undefined
}

const _objectProperty = ({ name, node }: { name: string; node: ts.ObjectLiteralExpression }) =>
	node.properties.find(
		(property): property is ts.PropertyAssignment =>
			ts.isPropertyAssignment(property) && _propertyName({ name: property.name }) === name,
	)

const _unwrapExpression = ({ node }: { node: ts.Expression }): ts.Expression => {
	if (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isNonNullExpression(node)
	) {
		return _unwrapExpression({ node: node.expression })
	}

	return node
}

const _objectLiteralFromExpression = ({ node }: { node: ts.Expression }) => {
	const unwrapped = _unwrapExpression({ node })

	return ts.isObjectLiteralExpression(unwrapped) ? unwrapped : undefined
}

const _xstateImportsFromSourceFile = ({ sourceFile }: { sourceFile: ts.SourceFile }) => {
	const imports = new Map<string, string>()

	for (const statement of sourceFile.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== 'xstate' ||
			statement.importClause?.namedBindings === undefined ||
			!ts.isNamedImports(statement.importClause.namedBindings)
		) {
			continue
		}

		for (const element of statement.importClause.namedBindings.elements) {
			imports.set(element.name.text, element.propertyName?.text ?? element.name.text)
		}
	}

	return imports
}

const _isXstateIdentifier = ({ imports, name, node }: { imports: XstateImports; name: string; node: ts.Expression }) =>
	ts.isIdentifier(node) && imports.get(node.text) === name

const _isSetupCreateMachineCall = ({ imports, node }: { imports: XstateImports; node: ts.CallExpression }) =>
	ts.isPropertyAccessExpression(node.expression) &&
	node.expression.name.text === 'createMachine' &&
	ts.isCallExpression(node.expression.expression) &&
	_isXstateIdentifier({
		imports,
		name: 'setup',
		node: node.expression.expression.expression,
	})

const _setupCallFromCreateMachineCall = ({ imports, node }: { imports: XstateImports; node: ts.CallExpression }) =>
	_isSetupCreateMachineCall({ imports, node }) &&
	ts.isPropertyAccessExpression(node.expression) &&
	ts.isCallExpression(node.expression.expression)
		? node.expression.expression
		: undefined

const _contextTypeFromSetupCall = ({ context, node }: { context: RuleContext; node: ts.CallExpression }) => {
	const setupOptions = node.arguments[0]

	if (setupOptions === undefined || !ts.isObjectLiteralExpression(setupOptions)) {
		return undefined
	}

	const typesProperty = _objectProperty({ name: 'types', node: setupOptions })
	const typesObject =
		typesProperty === undefined ? undefined : _objectLiteralFromExpression({ node: typesProperty.initializer })

	if (typesObject === undefined) {
		return undefined
	}

	const contextProperty = _objectProperty({
		name: 'context',
		node: typesObject,
	})

	return contextProperty === undefined ? undefined : context.checker.getTypeAtLocation(contextProperty.initializer)
}

const _isBooleanType = ({ context, type }: { context: RuleContext; type: ts.Type }) =>
	context.checker.typeToString(type) === _booleanTypeName

const _booleanFieldsFromContextType = ({
	context,
	contextType,
	node,
}: {
	context: RuleContext
	contextType: ts.Type
	node: ts.Node
}) => {
	const fields = new Map<string, ContextField>()

	for (const property of contextType.getProperties()) {
		const name = property.name
		const fieldType = context.checker.getTypeOfSymbolAtLocation(property, node)

		if (!_isBooleanType({ context, type: fieldType })) {
			continue
		}

		fields.set(name, {
			contextType,
			declaration: property.declarations?.[0],
			name,
		})
	}

	return fields
}

const _collectObjectLiteralAssignedFields = ({
	fields,
	node,
	output,
}: {
	fields: ReadonlyMap<string, ContextField>
	node: ts.ObjectLiteralExpression
	output: Set<string>
}) => {
	for (const property of node.properties) {
		const name =
			ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
				? _propertyName({ name: property.name })
				: undefined

		if (name !== undefined && fields.has(name)) {
			output.add(name)
		}
	}
}

const _collectReturnedObjectLiterals = ({
	node,
	output,
}: {
	node: ts.ConciseBody | ts.Block
	output: Array<ts.ObjectLiteralExpression>
}) => {
	const expressionObject = ts.isBlock(node) ? undefined : _objectLiteralFromExpression({ node })

	if (expressionObject !== undefined) {
		output.push(expressionObject)
		return
	}

	if (!ts.isBlock(node)) {
		return
	}

	const visit = (child: ts.Node) => {
		if (ts.isReturnStatement(child) && child.expression !== undefined) {
			const returnedObject = _objectLiteralFromExpression({
				node: child.expression,
			})

			if (returnedObject !== undefined) {
				output.push(returnedObject)
			}
		}

		ts.forEachChild(child, visit)
	}

	visit(node)
}

const _collectAssignedFieldsFromAssignArgument = ({
	fields,
	localObjectLiterals,
	node,
	output,
}: {
	fields: ReadonlyMap<string, ContextField>
	localObjectLiterals: ReadonlyMap<string, ts.ObjectLiteralExpression>
	node: ts.Expression
	output: Set<string>
}) => {
	const objectLiteral = _objectLiteralFromExpression({ node })

	if (objectLiteral !== undefined) {
		_collectObjectLiteralAssignedFields({
			fields,
			node: objectLiteral,
			output,
		})
		return
	}

	if (ts.isIdentifier(node)) {
		const referencedObject = localObjectLiterals.get(node.text)

		if (referencedObject !== undefined) {
			_collectObjectLiteralAssignedFields({
				fields,
				node: referencedObject,
				output,
			})
		}

		return
	}

	if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
		return
	}

	const returnedObjects: Array<ts.ObjectLiteralExpression> = []

	_collectReturnedObjectLiterals({ node: node.body, output: returnedObjects })

	for (const returnedObject of returnedObjects) {
		_collectObjectLiteralAssignedFields({
			fields,
			node: returnedObject,
			output,
		})
	}
}

const _collectLocalObjectLiterals = ({ sourceFile }: { sourceFile: ts.SourceFile }) => {
	const objectLiterals = new Map<string, ts.ObjectLiteralExpression>()

	const visit = (node: ts.Node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
			const objectLiteral = _objectLiteralFromExpression({
				node: node.initializer,
			})

			if (objectLiteral !== undefined) {
				objectLiterals.set(node.name.text, objectLiteral)
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(sourceFile)

	return objectLiterals
}

const _collectAssignedFields = ({
	fields,
	imports,
	localObjectLiterals,
	machineConfig,
}: {
	fields: ReadonlyMap<string, ContextField>
	imports: XstateImports
	localObjectLiterals: ReadonlyMap<string, ts.ObjectLiteralExpression>
	machineConfig: ts.ObjectLiteralExpression
}) => {
	const assignedFields = new Set<string>()

	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && _isXstateIdentifier({ imports, name: 'assign', node: node.expression })) {
			const assignArgument = node.arguments[0]

			if (assignArgument !== undefined) {
				_collectAssignedFieldsFromAssignArgument({
					fields,
					localObjectLiterals,
					node: assignArgument,
					output: assignedFields,
				})
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(machineConfig)

	return assignedFields
}

const _contextNamesFromFunctionParameters = ({ node }: { node: ts.ArrowFunction | ts.FunctionExpression }) => {
	const names = new Set<string>()
	const firstParameter = node.parameters[0]

	if (firstParameter === undefined) {
		return names
	}

	if (ts.isIdentifier(firstParameter.name)) {
		names.add(`${firstParameter.name.text}.context`)
		return names
	}

	if (!ts.isObjectBindingPattern(firstParameter.name)) {
		return names
	}

	for (const element of firstParameter.name.elements) {
		if (element.propertyName === undefined) {
			if (ts.isIdentifier(element.name) && element.name.text === 'context') {
				names.add('context')
			}

			continue
		}

		if (_propertyName({ name: element.propertyName }) === 'context' && ts.isIdentifier(element.name)) {
			names.add(element.name.text)
		}
	}

	return names
}

const _isContextFieldRead = ({
	contextNames,
	fieldName,
	node,
}: {
	contextNames: ReadonlySet<string>
	fieldName: string
	node: ts.PropertyAccessExpression
}) => {
	if (node.name.text !== fieldName) {
		return false
	}

	if (ts.isIdentifier(node.expression)) {
		return contextNames.has(node.expression.text)
	}

	return (
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === 'context' &&
		ts.isIdentifier(node.expression.expression) &&
		contextNames.has(`${node.expression.expression.text}.context`)
	)
}

const _collectContextReadsFromGuard = ({
	fields,
	node,
	output,
}: {
	fields: ReadonlyMap<string, ContextField>
	node: ts.Expression
	output: Set<string>
}) => {
	if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
		return
	}

	const contextNames = _contextNamesFromFunctionParameters({ node })

	if (contextNames.size === 0) {
		return
	}

	const visit = (child: ts.Node) => {
		if (ts.isPropertyAccessExpression(child)) {
			for (const fieldName of fields.keys()) {
				if (_isContextFieldRead({ contextNames, fieldName, node: child })) {
					output.add(fieldName)
				}
			}
		}

		ts.forEachChild(child, visit)
	}

	visit(node.body)
}

const _collectGuardFields = ({
	fields,
	machineConfig,
}: {
	fields: ReadonlyMap<string, ContextField>
	machineConfig: ts.ObjectLiteralExpression
}) => {
	const guardFields = new Set<string>()

	const visit = (node: ts.Node) => {
		if (ts.isPropertyAssignment(node) && _propertyName({ name: node.name }) === 'guard') {
			_collectContextReadsFromGuard({
				fields,
				node: node.initializer,
				output: guardFields,
			})
		}

		ts.forEachChild(node, visit)
	}

	visit(machineConfig)

	return guardFields
}

const _sameType = ({ context, left, right }: { context: RuleContext; left: ts.Type; right: ts.Type }) =>
	context.checker.isTypeAssignableTo(left, right) && context.checker.isTypeAssignableTo(right, left)

const _collectSnapshotFields = ({
	context,
	fields,
	sourceFile,
}: {
	context: RuleContext
	fields: ReadonlyMap<string, ContextField>
	sourceFile: ts.SourceFile
}) => {
	const snapshotFields = new Set<string>()

	const visit = (node: ts.Node) => {
		if (
			ts.isPropertyAccessExpression(node) &&
			fields.has(node.name.text) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'context'
		) {
			const snapshotContextType = context.checker.getTypeAtLocation(node.expression)
			const field = fields.get(node.name.text)

			if (
				field !== undefined &&
				_sameType({
					context,
					left: snapshotContextType,
					right: field.contextType,
				})
			) {
				snapshotFields.add(node.name.text)
			}
		}

		ts.forEachChild(node, visit)
	}

	visit(sourceFile)

	return snapshotFields
}

const _machineContextFromCreateMachineCall = ({
	context,
	imports,
	localObjectLiterals,
	node,
}: {
	context: RuleContext
	imports: XstateImports
	localObjectLiterals: ReadonlyMap<string, ts.ObjectLiteralExpression>
	node: ts.CallExpression
}) => {
	const setupCall = _setupCallFromCreateMachineCall({ imports, node })
	const machineConfig = node.arguments[0]

	if (setupCall === undefined || machineConfig === undefined || !ts.isObjectLiteralExpression(machineConfig)) {
		return undefined
	}

	const contextType = _contextTypeFromSetupCall({ context, node: setupCall })

	if (contextType === undefined) {
		return undefined
	}

	const fields = _booleanFieldsFromContextType({
		context,
		contextType,
		node: setupCall,
	})

	if (fields.size === 0) {
		return undefined
	}

	return {
		assignedFields: _collectAssignedFields({
			fields,
			imports,
			localObjectLiterals,
			machineConfig,
		}),
		fields,
		guardFields: _collectGuardFields({ fields, machineConfig }),
		machineConfig,
		snapshotFields: _collectSnapshotFields({
			context,
			fields,
			sourceFile: context.sourceFile,
		}),
	} satisfies MachineContext
}

const _reportNodeForField = ({
	field,
	machineConfig,
}: {
	field: ContextField
	machineConfig: ts.ObjectLiteralExpression
}) => (field.declaration?.getSourceFile() === machineConfig.getSourceFile() ? field.declaration : machineConfig)

const _report = ({
	context,
	field,
	machineConfig,
}: {
	context: RuleContext
	field: ContextField
	machineConfig: ts.ObjectLiteralExpression
}) => {
	const node = _reportNodeForField({ field, machineConfig })
	const position = context.sourceFile.getLineAndCharacterOfPosition(node.getStart(context.sourceFile))

	context.report({
		column: position.character + 1,
		fileName: context.sourceFile.fileName,
		line: position.line + 1,
		message: `XState context field "${field.name}" caches transition availability. Move the predicate into the transition guard and use snapshot.can(event) from the UI instead of assigning a boolean context flag.`,
	})
}

const noXstateDerivedBooleanContext: TypedRule = {
	name: 'no-xstate-derived-boolean-context',
	check: (context) => {
		const imports = _xstateImportsFromSourceFile({
			sourceFile: context.sourceFile,
		})

		if (imports.size === 0) {
			return
		}

		const localObjectLiterals = _collectLocalObjectLiterals({
			sourceFile: context.sourceFile,
		})
		const reported = new Set<string>()

		const visit = (node: ts.Node) => {
			if (!ts.isCallExpression(node)) {
				ts.forEachChild(node, visit)
				return
			}

			const machine = _machineContextFromCreateMachineCall({
				context,
				imports,
				localObjectLiterals,
				node,
			})

			if (machine === undefined) {
				ts.forEachChild(node, visit)
				return
			}

			for (const [fieldName, field] of machine.fields) {
				if (
					!machine.assignedFields.has(fieldName) ||
					!machine.guardFields.has(fieldName) ||
					!machine.snapshotFields.has(fieldName)
				) {
					continue
				}

				const reportKey = `${fieldName}:${_reportNodeForField({
					field,
					machineConfig: machine.machineConfig,
				}).getStart(context.sourceFile)}`

				if (reported.has(reportKey)) {
					continue
				}

				reported.add(reportKey)
				_report({ context, field, machineConfig: machine.machineConfig })
			}

			ts.forEachChild(node, visit)
		}

		visit(context.sourceFile)
	},
}

export default noXstateDerivedBooleanContext
