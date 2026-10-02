import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

type Node = {
	argument?: unknown
	arguments?: Array<unknown>
	body?: unknown
	callee?: unknown
	expression?: unknown
	name?: unknown
	range: [number, number]
	type: string
}

const message = 'XState sent object events must use satisfies with the target event type.'

const unwrapExpression = ({ node }: { node: Node }): Node => {
	if (
		node.type === 'ParenthesizedExpression' ||
		node.type === 'ChainExpression' ||
		node.type === 'TSNonNullExpression'
	) {
		return !isNode(node.expression) ? node : unwrapExpression({ node: node.expression })
	}

	return node
}

const isNode = (value: unknown): value is Node => {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	return 'type' in value && typeof value.type === 'string' && 'range' in value && Array.isArray(value.range)
}

const nodeList = ({ value }: { value: unknown }): Array<Node> => (Array.isArray(value) ? value.filter(isNode) : [])

const isSatisfiedObjectEvent = ({ node }: { node: Node }) => {
	const expression = unwrapExpression({ node })

	return (
		expression.type === 'TSSatisfiesExpression' &&
		isNode(expression.expression) &&
		unwrapExpression({ node: expression.expression }).type === 'ObjectExpression'
	)
}

const isBareObjectEvent = ({ node }: { node: Node }) => unwrapExpression({ node }).type === 'ObjectExpression'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Require XState sent object events to use a satisfies event type.',
		},
	},
	create(context) {
		const collectEventObjectsMissingSatisfies = ({ node }: { node: Node }): Array<Node> => {
			const eventFactory = unwrapExpression({ node })

			if (isSatisfiedObjectEvent({ node: eventFactory })) {
				return []
			}

			if (isBareObjectEvent({ node: eventFactory })) {
				return [eventFactory]
			}

			if (eventFactory.type === 'ArrowFunctionExpression' || eventFactory.type === 'FunctionExpression') {
				if (eventFactory.body === undefined) {
					return []
				}

				if (
					!Array.isArray(eventFactory.body) &&
					isNode(eventFactory.body) &&
					eventFactory.body.type === 'BlockStatement' &&
					Array.isArray(eventFactory.body.body)
				) {
					return nodeList({ value: eventFactory.body.body }).flatMap((statement) => {
						if (statement.type !== 'ReturnStatement' || !isNode(statement.argument)) {
							return []
						}

						const argument = unwrapExpression({ node: statement.argument })

						if (isSatisfiedObjectEvent({ node: argument })) {
							return []
						}

						return isBareObjectEvent({ node: argument }) ? [argument] : []
					})
				}

				if (!Array.isArray(eventFactory.body) && isNode(eventFactory.body)) {
					const body = unwrapExpression({ node: eventFactory.body })

					if (isSatisfiedObjectEvent({ node: body })) {
						return []
					}

					return isBareObjectEvent({ node: body }) ? [body] : []
				}

				return nodeList({ value: eventFactory.body }).flatMap((statement) => {
					if (statement.type !== 'ReturnStatement' || !isNode(statement.argument)) {
						return []
					}

					const argument = unwrapExpression({ node: statement.argument })

					if (isSatisfiedObjectEvent({ node: argument })) {
						return []
					}

					return isBareObjectEvent({ node: argument }) ? [argument] : []
				})
			}

			return []
		}

		return {
			CallExpression(node) {
				const eventArgumentIndex =
					isNode(node.callee) && node.callee.type === 'Identifier'
						? node.callee.name === 'sendParent'
							? 0
							: node.callee.name === 'sendTo'
								? 1
								: undefined
						: undefined

				if (eventArgumentIndex === undefined) {
					return
				}

				const eventArgument = node.arguments.at(eventArgumentIndex)

				if (!isNode(eventArgument)) {
					return
				}

				for (const eventObject of collectEventObjectsMissingSatisfies({
					node: eventArgument,
				})) {
					context.report({
						node: eventObject,
						message,
					})
				}
			},
		}
	},
}

export default rule
