import { eslintCompatPlugin } from '@oxlint/plugins'

import noAmbientNondeterminism from './rules/no-ambient-nondeterminism.ts'
import noDisableValidation from './rules/no-disable-validation.ts'
import noManualTagComparison from './rules/no-manual-tag-comparison.ts'
import noManualTaggedConstruction from './rules/no-manual-tagged-construction.ts'
import noServiceOption from './rules/no-service-option.ts'
import noShadowedStandardArrayStatic from './rules/no-shadowed-standard-array-static.ts'
import noSilentErrorSwallow from './rules/no-silent-error-swallow.ts'
import preferEffectMatch from './rules/prefer-effect-match.ts'
import preferOptionFromNullable from './rules/prefer-option-from-nullable.ts'
import preferTaggedErrorHandling from './rules/prefer-tagged-error-handling.ts'

export default eslintCompatPlugin({
	meta: { name: 'automation' },
	rules: {
		'no-ambient-nondeterminism': noAmbientNondeterminism,
		'no-disable-validation': noDisableValidation,
		'no-manual-tag-comparison': noManualTagComparison,
		'no-manual-tagged-construction': noManualTaggedConstruction,
		'no-service-option': noServiceOption,
		'no-shadowed-standard-array-static': noShadowedStandardArrayStatic,
		'no-silent-error-swallow': noSilentErrorSwallow,
		'prefer-effect-match': preferEffectMatch,
		'prefer-option-from-nullable': preferOptionFromNullable,
		'prefer-tagged-error-handling': preferTaggedErrorHandling,
	},
})
