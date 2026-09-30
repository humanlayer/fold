import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

type Node = {
	[key: string]: unknown
	type: string
}

const bannedBrowserStorageNames = new Set(['indexedDB', 'localStorage', 'sessionStorage'])

const isNode = (value: unknown): value is Node =>
	typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'

const getStorageIdentifierName = (node: unknown) =>
	isNode(node) &&
	node.type === 'Identifier' &&
	typeof node.name === 'string' &&
	bannedBrowserStorageNames.has(node.name)
		? node.name
		: undefined

const messageFor = ({ name }: { name: string }) =>
	`Do not use ${name} directly. Use Effect's IndexedDb or KeyValueStore modules instead.`

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Disallow direct browser storage APIs in favor of Effect storage modules.',
		},
	},
	create(context) {
		return {
			Identifier(node) {
				const storageName = getStorageIdentifierName(node)

				if (storageName === undefined) {
					return
				}

				const parent = isNode(node.parent) ? node.parent : undefined

				if (
					(parent?.type === 'Property' &&
						parent.key === node &&
						(!isNode(parent.parent) || parent.parent.type !== 'ObjectPattern') &&
						parent.value !== node) ||
					(parent?.type === 'MemberExpression' && parent.property === node && parent.computed !== true) ||
					(parent?.type === 'ImportSpecifier' && parent.imported === node && parent.local !== node) ||
					(parent?.type === 'MemberExpression' && parent.object === node)
				) {
					return
				}

				context.report({
					node,
					message: messageFor({ name: storageName }),
				})
			},
			MemberExpression(node) {
				const storageName =
					node.object.type === 'Identifier' ? getStorageIdentifierName(node.object) : undefined

				if (storageName !== undefined) {
					context.report({
						node,
						message: messageFor({ name: storageName }),
					})
					return
				}

				if (
					node.object.type === 'Identifier' &&
					(node.object.name === 'globalThis' || node.object.name === 'window')
				) {
					const propertyName =
						node.property.type === 'Identifier'
							? node.property.name
							: node.property.type === 'Literal' && typeof node.property.value === 'string'
								? node.property.value
								: undefined

					if (!bannedBrowserStorageNames.has(propertyName ?? '')) {
						return
					}

					context.report({
						node,
						message: messageFor({
							name: propertyName ?? '',
						}),
					})
				}
			},
		}
	},
}

export default rule
