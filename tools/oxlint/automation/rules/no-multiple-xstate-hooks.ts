import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

type Component = { name: string; node: object }
type ParentNode = {
	id?: unknown
	parent?: ParentNode | null
	type: string
}
type FunctionNode = ParentNode

const xstateActorHooks = new Set(['useActor', 'useActorRef', 'useMachine'])

const isComponentName = (name: string | undefined) => name !== undefined && /^[A-Z]/.test(name)

const identifierName = ({ node }: { node: unknown }) => {
	if (typeof node !== 'object' || node === null) {
		return undefined
	}

	if (!('name' in node) || typeof node.name !== 'string') {
		return undefined
	}

	return node.name
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description:
				'Disallow multiple @xstate/react actor hooks in the same component. Compose machines with actors instead.',
		},
	},
	create(context) {
		const localHookNames = new Set<string>()
		const namespaceNames = new Set<string>()
		const componentHookCounts = new WeakMap<object, number>()
		const functionStack = new Array<Component | undefined>()

		const componentName = (node: FunctionNode): string | undefined => {
			if (node.type === 'FunctionDeclaration') {
				const name = identifierName({ node: node.id })

				return isComponentName(name) ? name : undefined
			}

			const parent = node.parent

			if (parent?.type === 'VariableDeclarator') {
				const name = identifierName({ node: parent.id })

				return isComponentName(name) ? name : undefined
			}

			if (parent?.type === 'CallExpression') {
				const variableDeclarator = parent.parent

				if (variableDeclarator?.type === 'VariableDeclarator') {
					const name = identifierName({ node: variableDeclarator.id })

					return isComponentName(name) ? name : undefined
				}
			}

			return undefined
		}

		const enterFunction = (node: FunctionNode) => {
			const name = componentName(node)

			functionStack.push(name === undefined ? undefined : { name, node })
		}

		const exitFunction = () => {
			functionStack.pop()
		}

		return {
			ArrowFunctionExpression: enterFunction,
			'ArrowFunctionExpression:exit': exitFunction,
			FunctionDeclaration: enterFunction,
			'FunctionDeclaration:exit': exitFunction,
			FunctionExpression: enterFunction,
			'FunctionExpression:exit': exitFunction,
			ImportDeclaration(node) {
				if (node.source.value !== '@xstate/react') return

				for (const specifier of node.specifiers) {
					if (specifier.type === 'ImportNamespaceSpecifier') {
						namespaceNames.add(specifier.local.name)
					} else if (
						specifier.type === 'ImportSpecifier' &&
						specifier.imported.type === 'Identifier' &&
						xstateActorHooks.has(specifier.imported.name)
					) {
						localHookNames.add(specifier.local.name)
					}
				}
			},
			CallExpression(node) {
				const callee = node.callee
				const hookName =
					callee.type === 'Identifier' && localHookNames.has(callee.name)
						? callee.name
						: callee.type === 'MemberExpression' &&
							  callee.object.type === 'Identifier' &&
							  callee.property.type === 'Identifier' &&
							  namespaceNames.has(callee.object.name) &&
							  xstateActorHooks.has(callee.property.name)
							? callee.property.name
							: undefined

				if (hookName === undefined) return

				const component = functionStack.at(-1)

				if (component === undefined) return

				const currentCount = componentHookCounts.get(component.node) ?? 0
				componentHookCounts.set(component.node, currentCount + 1)

				if (currentCount === 0) return

				context.report({
					node: callee,
					message: `${component.name} uses multiple @xstate/react actor hooks. Compose machines with actors instead.`,
				})
			},
		}
	},
}

export default rule
