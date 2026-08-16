import { eslintCompatPlugin } from '@oxlint/plugins'

import noDisableValidation from './rules/no-disable-validation.ts'
import noShadowedStandardArrayStatic from './rules/no-shadowed-standard-array-static.ts'
import noSilentErrorSwallow from './rules/no-silent-error-swallow.ts'

export default eslintCompatPlugin({
	meta: { name: 'automation' },
	rules: {
		'no-disable-validation': noDisableValidation,
		'no-shadowed-standard-array-static': noShadowedStandardArrayStatic,
		'no-silent-error-swallow': noSilentErrorSwallow,
	},
})
