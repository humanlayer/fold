import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

type Node = {
	[key: string]: unknown
	type: string
}

const ignoredKeys = new Set(['parent'])

const isNode = (value: unknown): value is Node =>
	typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

const nodeName = ({ value }: { value: unknown }) =>
	isNode(value) && typeof value.name === 'string' ? value.name : undefined

const isEffectArrayCall = ({ node }: { node: unknown }) =>
	isNode(node) &&
	node.type === 'CallExpression' &&
	isNode(node.callee) &&
	node.callee.type === 'MemberExpression' &&
	isNode(node.callee.object) &&
	isNode(node.callee.property) &&
	node.callee.object.type === 'Identifier' &&
	node.callee.object.name === 'Array' &&
	node.callee.property.type === 'Identifier'

const containsEffectArrayCall = ({ node, seen }: { node: unknown; seen: WeakSet<object> }): boolean => {
	if (node === null || typeof node !== 'object') {
		return false
	}

	if (seen.has(node)) {
		return false
	}

	seen.add(node)

	if (isEffectArrayCall({ node })) {
		return true
	}

	for (const [key, value] of Object.entries(node)) {
		if (ignoredKeys.has(key)) {
			continue
		}

		if (Array.isArray(value)) {
			if (value.some((item) => containsEffectArrayCall({ node: item, seen }))) {
				return true
			}

			continue
		}

		if (containsEffectArrayCall({ node: value, seen })) {
			return true
		}
	}

	return false
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid nested Effect Array method calls; compose them with pipe to preserve inference.',
		},
	},
	create(context) {
		let arrayImportedFromEffect = false

		return {
			ImportDeclaration(node) {
				if (
					isNode(node) &&
					isNode(node.source) &&
					node.source.value === 'effect' &&
					Array.isArray(node.specifiers) &&
					node.specifiers
						.filter(isNode)
						.some(
							(specifier) =>
								specifier.type === 'ImportSpecifier' &&
								nodeName({ value: specifier.imported }) === 'Array' &&
								nodeName({ value: specifier.local }) === 'Array',
						)
				) {
					arrayImportedFromEffect = true
				}
			},
			CallExpression(node) {
				if (!arrayImportedFromEffect || !isEffectArrayCall({ node })) {
					return
				}

				if (
					node.arguments.some((argument) =>
						containsEffectArrayCall({
							node: argument,
							seen: new WeakSet<object>(),
						}),
					)
				) {
					context.report({
						node,
						message: 'Do not nest Effect Array method calls. Use pipe to preserve inference.',
					})
				}
			},
		}
	},
}

export default rule
