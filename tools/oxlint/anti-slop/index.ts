import { eslintCompatPlugin } from '@oxlint/plugins'

import { noConditionalEmptyObjectSpreadRule } from './rules/no-conditional-empty-object-spread.ts'
import { noModuleMockingRule } from './rules/no-module-mocking.ts'
import { noObjectParametersRule } from './rules/no-object-parameters.ts'
import { noReflectApplyRule } from './rules/no-reflect-apply.ts'

export default eslintCompatPlugin({
	meta: { name: 'anti-slop' },
	rules: {
		'no-conditional-empty-object-spread': noConditionalEmptyObjectSpreadRule,
		'no-module-mocking': noModuleMockingRule,
		'no-object-parameters': noObjectParametersRule,
		'no-reflect-apply': noReflectApplyRule,
	},
})
