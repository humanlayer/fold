import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

type Node = {
	readonly [key: string]: unknown
	readonly type: string
}

const message = 'Do not use the global JSON API. Use Effect Schema encode/decode APIs instead.'

const _isNode = (value: unknown): value is Node =>
	typeof value === 'object' &&
	value !== null &&
	Object.hasOwn(value, 'type') &&
	typeof Reflect.get(value, 'type') === 'string'

const _nodeField = ({ field, node }: { field: string; node: Node }) => node[field]

const _isIdentifier = ({ name, node }: { name: string; node: unknown }) =>
	_isNode(node) && node.type === 'Identifier' && _nodeField({ field: 'name', node }) === name

const _isGlobalJson = (node: unknown): boolean => {
	if (_isIdentifier({ name: 'JSON', node })) {
		return true
	}

	if (!_isNode(node) || node.type !== 'MemberExpression') {
		return false
	}

	return (
		_isIdentifier({
			name: 'globalThis',
			node: _nodeField({ field: 'object', node }),
		}) &&
		_isIdentifier({
			name: 'JSON',
			node: _nodeField({ field: 'property', node }),
		})
	)
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid global JSON APIs; encode and decode JSON with Effect Schema.',
		},
	},
	create(context) {
		return {
			MemberExpression(node) {
				if (!_isGlobalJson(node.object)) {
					return
				}

				context.report({
					node,
					message,
				})
			},
		}
	},
}

export default rule
