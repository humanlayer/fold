import * as ts from 'typescript-compiler'

import type { RuleContext, TypedRule } from '../rule.js'

const _isNumberLiteral = ({ node, value }: { node: ts.Node; value: 0 | 1 }) =>
	ts.isNumericLiteral(node) && Number(node.text) === value

const _isAnyOrUnknown = ({ type }: { type: ts.Type }) =>
	(type.flags & ts.TypeFlags.Any) === ts.TypeFlags.Any || (type.flags & ts.TypeFlags.Unknown) === ts.TypeFlags.Unknown

const _isArrayType = ({ checker, type }: { checker: ts.TypeChecker; type: ts.Type }): boolean => {
	if (_isAnyOrUnknown({ type })) {
		return false
	}

	if (type.isUnion()) {
		return type.types.every((member) => _isArrayType({ checker, type: member }))
	}

	return checker.isArrayType(type) || checker.isTupleType(type)
}

const _isArrayLength = ({ context, node }: { context: RuleContext; node: ts.Node }) => {
	if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'length') {
		return false
	}

	const type = context.checker.getTypeAtLocation(node.expression)

	return _isArrayType({ checker: context.checker, type })
}

const _isEmptyLengthComparison = ({ context, node }: { context: RuleContext; node: ts.BinaryExpression }) => {
	const leftIsLength = _isArrayLength({ context, node: node.left })
	const rightIsLength = _isArrayLength({ context, node: node.right })

	if (!leftIsLength && !rightIsLength) {
		return false
	}

	switch (node.operatorToken.kind) {
		case ts.SyntaxKind.EqualsEqualsEqualsToken:
		case ts.SyntaxKind.EqualsEqualsToken:
		case ts.SyntaxKind.ExclamationEqualsEqualsToken:
		case ts.SyntaxKind.ExclamationEqualsToken:
			return leftIsLength
				? _isNumberLiteral({ node: node.right, value: 0 })
				: _isNumberLiteral({ node: node.left, value: 0 })
		case ts.SyntaxKind.GreaterThanToken:
			return (
				(leftIsLength && _isNumberLiteral({ node: node.right, value: 0 })) ||
				(rightIsLength && _isNumberLiteral({ node: node.left, value: 1 }))
			)
		case ts.SyntaxKind.GreaterThanEqualsToken:
			return (
				(leftIsLength && _isNumberLiteral({ node: node.right, value: 1 })) ||
				(rightIsLength && _isNumberLiteral({ node: node.left, value: 0 }))
			)
		case ts.SyntaxKind.LessThanToken:
			return (
				(leftIsLength && _isNumberLiteral({ node: node.right, value: 1 })) ||
				(rightIsLength && _isNumberLiteral({ node: node.left, value: 0 }))
			)
		case ts.SyntaxKind.LessThanEqualsToken:
			return (
				(leftIsLength && _isNumberLiteral({ node: node.right, value: 0 })) ||
				(rightIsLength && _isNumberLiteral({ node: node.left, value: 1 }))
			)
		default:
			return false
	}
}

const _report = ({ context, node }: { context: RuleContext; node: ts.Node }) => {
	const position = context.sourceFile.getLineAndCharacterOfPosition(node.getStart(context.sourceFile))

	context.report({
		column: position.character + 1,
		fileName: context.sourceFile.fileName,
		line: position.line + 1,
		message:
			'Use Array.match, Array.isReadonlyArrayNonEmpty, Array.isArrayNonEmpty, or NonEmptyArray from effect instead of checking array.length for emptiness.',
	})
}

const _checkNode = ({ context, node }: { context: RuleContext; node: ts.Node }) => {
	if (ts.isBinaryExpression(node)) {
		if (_isEmptyLengthComparison({ context, node })) {
			_report({ context, node })
		}

		return
	}

	if (
		ts.isPrefixUnaryExpression(node) &&
		node.operator === ts.SyntaxKind.ExclamationToken &&
		_isArrayLength({ context, node: node.operand })
	) {
		_report({ context, node })
	}
}

const preferEffectArrayMatch: TypedRule = {
	name: 'prefer-effect-array-match',
	check: (context) => {
		const visit = (node: ts.Node) => {
			_checkNode({ context, node })
			ts.forEachChild(node, visit)
		}

		visit(context.sourceFile)
	},
}

export default preferEffectArrayMatch
