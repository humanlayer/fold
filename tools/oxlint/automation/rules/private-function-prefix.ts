import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type Ranged = { range: [number, number] }

const functionTypes = new Set(['ArrowFunctionExpression', 'FunctionExpression'])

const message = 'Private top-level functions must start with an underscore.'

const _isPascalCase = (name: string) => /^[A-Z]/.test(name)

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Require private top-level functions and const function values to start with an underscore.',
		},
	},
	create(context) {
		const report = (node: Ranged) => {
			context.report({
				node,
				message,
			})
		}

		return {
			FunctionDeclaration(node) {
				if (
					node.id !== null &&
					(node.parent?.type === 'Program' || node.parent?.type === 'ExportNamedDeclaration') &&
					node.parent?.type !== 'ExportNamedDeclaration' &&
					!_isPascalCase(node.id.name) &&
					!node.id.name.startsWith('_')
				) {
					report(node.id)
				}
			},
			VariableDeclarator(node) {
				if (
					node.id.type !== 'Identifier' ||
					node.init === null ||
					!functionTypes.has(node.init.type) ||
					node.parent?.type !== 'VariableDeclaration' ||
					node.parent.parent?.type !== 'Program'
				) {
					return
				}

				if (!_isPascalCase(node.id.name) && !node.id.name.startsWith('_')) {
					report(node.id)
				}
			},
		}
	},
}

export default rule
