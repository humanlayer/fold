import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const message = 'Do not use try/catch. Use Effect.try, Effect.tryPromise, or explicit error channels instead.'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Avoid try/catch; use Effect.try, Effect.tryPromise, or explicit error channels.',
		},
	},
	create(context) {
		return {
			TryStatement(node) {
				context.report({
					node,
					message,
				})
			},
		}
	},
}

export default rule
