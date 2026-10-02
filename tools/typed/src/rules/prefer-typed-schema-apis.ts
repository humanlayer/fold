import * as ts from 'typescript-compiler'

import type { RuleContext, TypedRule } from '../rule.js'

const _decodeMethods = new Map([
	['decodeUnknownEffect', 'decodeEffect'],
	['decodeUnknownExit', 'decodeExit'],
	['decodeUnknownOption', 'decodeOption'],
	['decodeUnknownResult', 'decodeResult'],
	['decodeUnknownPromise', 'decodePromise'],
	['decodeUnknownSync', 'decodeSync'],
])

const _encodeMethods = new Map([
	['encodeUnknownEffect', 'encodeEffect'],
	['encodeUnknownExit', 'encodeExit'],
	['encodeUnknownOption', 'encodeOption'],
	['encodeUnknownResult', 'encodeResult'],
	['encodeUnknownPromise', 'encodePromise'],
	['encodeUnknownSync', 'encodeSync'],
])

const _findImportDeclaration = ({ node }: { node: ts.Node }) => {
	let current: ts.Node | undefined = node

	while (current !== undefined) {
		if (ts.isImportDeclaration(current)) {
			return current
		}

		current = current.parent
	}

	return undefined
}

const _isEffectSchemaImport = ({ checker, node }: { checker: ts.TypeChecker; node: ts.Identifier }) => {
	const symbol = checker.getSymbolAtLocation(node)

	if (symbol === undefined) {
		return false
	}

	if (
		symbol.declarations?.some((declaration) => {
			const importDeclaration = _findImportDeclaration({ node: declaration })

			if (importDeclaration === undefined) {
				return false
			}

			return importDeclaration.moduleSpecifier.getText() === '"effect"'
		}) === true
	) {
		return true
	}

	const aliasedSymbol =
		(symbol.flags & ts.SymbolFlags.Alias) === ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol

	return aliasedSymbol.declarations?.some((declaration) => {
		const importDeclaration = _findImportDeclaration({ node: declaration })

		if (importDeclaration === undefined) {
			return false
		}

		return importDeclaration.moduleSpecifier.getText() === '"effect"'
	})
}

const _isAnyOrUnknown = ({ flags }: { flags: ts.TypeFlags }) =>
	(flags & ts.TypeFlags.Any) === ts.TypeFlags.Any || (flags & ts.TypeFlags.Unknown) === ts.TypeFlags.Unknown

const _getPropertyType = ({
	checker,
	name,
	node,
	type,
}: {
	checker: ts.TypeChecker
	name: 'Encoded' | 'Type'
	node: ts.Node
	type: ts.Type
}) => {
	const property = checker.getPropertyOfType(type, name)

	if (property === undefined) {
		return undefined
	}

	return checker.getTypeOfSymbolAtLocation(property, node)
}

const _checkNode = ({ context, node }: { context: RuleContext; node: ts.Node }) => {
	if (!ts.isCallExpression(node) || !ts.isCallExpression(node.expression) || node.arguments.length === 0) {
		return
	}

	const input = node.arguments[0]

	if (input === undefined) {
		return
	}

	const schemaCall = node.expression
	const schema = schemaCall.arguments[0]

	if (
		schemaCall.arguments.length !== 1 ||
		schema === undefined ||
		!ts.isPropertyAccessExpression(schemaCall.expression) ||
		!ts.isIdentifier(schemaCall.expression.expression)
	) {
		return
	}

	const schemaIdentifier = schemaCall.expression.expression
	const unknownMethod = schemaCall.expression.name.text
	const decodeMethod = _decodeMethods.get(unknownMethod)
	const encodeMethod = _encodeMethods.get(unknownMethod)

	if (
		schemaIdentifier.text !== 'Schema' ||
		(decodeMethod === undefined && encodeMethod === undefined) ||
		!_isEffectSchemaImport({
			checker: context.checker,
			node: schemaIdentifier,
		})
	) {
		return
	}

	const inputType = context.checker.getTypeAtLocation(input)

	if (_isAnyOrUnknown({ flags: inputType.flags })) {
		return
	}

	const schemaType = context.checker.getTypeAtLocation(schema)
	const expectedType = _getPropertyType({
		checker: context.checker,
		name: decodeMethod === undefined ? 'Type' : 'Encoded',
		node: schema,
		type: schemaType,
	})

	if (
		expectedType === undefined ||
		_isAnyOrUnknown({ flags: expectedType.flags }) ||
		!context.checker.isTypeAssignableTo(inputType, expectedType)
	) {
		return
	}

	const replacement = decodeMethod ?? encodeMethod

	if (replacement === undefined) {
		return
	}

	const position = context.sourceFile.getLineAndCharacterOfPosition(
		schemaCall.expression.name.getStart(context.sourceFile),
	)

	context.report({
		column: position.character + 1,
		fileName: context.sourceFile.fileName,
		line: position.line + 1,
		message: `Prefer Schema.${replacement} when input is already typed as the schema ${
			decodeMethod === undefined ? 'Type' : 'Encoded'
		}. Replace Schema.${unknownMethod} with Schema.${replacement}.`,
	})
}

const preferTypedSchemaApis: TypedRule = {
	name: 'prefer-typed-schema-apis',
	check: (context) => {
		const visit = (node: ts.Node) => {
			_checkNode({ context, node })
			ts.forEachChild(node, visit)
		}

		visit(context.sourceFile)
	},
}

export default preferTypedSchemaApis
