import { defineRule } from '@oxlint/plugins'

/** Reject implementation comments except SAFETY justifications required by assertion policy. */
export const noCommentsRule = defineRule({
	meta: {
		type: 'problem',
		docs: {
			description:
				'Reject implementation comments; code should communicate intent directly. SAFETY justifications remain allowed.',
		},
		messages: {
			comment: 'Remove this comment and make the code communicate its intent directly.',
		},
	},
	createOnce(context) {
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					if (/\bSAFETY\s*:/u.test(comment.value)) continue
					context.report({ node: comment, messageId: 'comment' })
				}
			},
		}
	},
})
