import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const message = 'Switch statements are banned. Use Match from effect.'

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Disallow switch statements. Use Match from effect instead.',
		},
	},
	create(context) {
		return {
			SwitchStatement(node) {
				context.report({
					node,
					message,
				})
			},
		}
	},
}

export default rule
