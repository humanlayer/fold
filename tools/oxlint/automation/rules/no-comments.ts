import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]

const allowedDirective = /^(?:\/\s*<reference|@ts-|c8 |eslint-|istanbul |oxlint-)/

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description:
				'Remove source comments and keep code self-explanatory; compiler, coverage, and lint directives remain allowed.',
		},
	},
	create(context) {
		const filename = context.filename ?? ''

		if (filename.endsWith('.d.ts') || filename.includes('.generated.')) {
			return {}
		}

		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					if (comment.type === 'Shebang' || allowedDirective.test(comment.value.trim())) {
						continue
					}

					context.report({
						node: comment,
						message:
							'Remove this comment. Keep the code self-explanatory; lint and compiler directives remain available for explicit exceptions.',
					})
				}
			},
		}
	},
}

export default rule
