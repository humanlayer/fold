import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type ImportDeclarationNode = Parameters<NonNullable<VisitorObject['ImportDeclaration']>>[0]
type ExportAllDeclarationNode = Parameters<NonNullable<VisitorObject['ExportAllDeclaration']>>[0]
type ExportNamedDeclarationNode = Parameters<NonNullable<VisitorObject['ExportNamedDeclaration']>>[0]
type ImportExpressionNode = Parameters<NonNullable<VisitorObject['ImportExpression']>>[0]
type CallExpressionNode = Parameters<NonNullable<VisitorObject['CallExpression']>>[0]
type ReportableNode =
	| CallExpressionNode
	| ExportAllDeclarationNode
	| ExportNamedDeclarationNode
	| ImportDeclarationNode
	| ImportExpressionNode

const cssModulePattern = /\.module\.(?:css|less|sass|scss)$/i
const message = 'CSS Modules are not allowed. Use Tailwind utilities instead.'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Disallow CSS Modules so web styling stays in Tailwind utilities.',
		},
	},
	create(context) {
		const checkSource = ({ node, source }: { node: ReportableNode; source: unknown }) => {
			if (typeof source === 'string' && cssModulePattern.test(source)) {
				context.report({ node, message })
			}
		}

		return {
			CallExpression(node) {
				if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') {
					return
				}

				const source = node.arguments[0]
				checkSource({
					node,
					source: source?.type === 'Literal' ? source.value : undefined,
				})
			},
			ExportAllDeclaration(node) {
				checkSource({ node, source: node.source.value })
			},
			ExportNamedDeclaration(node) {
				checkSource({ node, source: node.source?.value })
			},
			ImportDeclaration(node) {
				checkSource({ node, source: node.source.value })
			},
			ImportExpression(node) {
				checkSource({
					node,
					source: node.source.type === 'Literal' ? node.source.value : undefined,
				})
			},
		}
	},
}

export default rule
