import {
	bootstrapFoldHome,
	loadFoldConfigOrNull,
	type ConfigInitOptions,
	type FoldConfig,
} from '@humanlayer/fold-agent'
import { Cause, Effect, Exit } from 'effect'

export type TuiConfigBootstrapResult = {
	readonly config: FoldConfig | null
	readonly notice: string | null
}

/** Bootstrap first, and only load a config after bootstrap has completed successfully. */
export const bootstrapTuiConfig = (options: ConfigInitOptions): Effect.Effect<TuiConfigBootstrapResult> =>
	Effect.gen(function* () {
		const bootstrapExit = yield* Effect.exit(bootstrapFoldHome(options))
		if (Exit.isFailure(bootstrapExit))
			return {
				config: null,
				notice: `CONFIGURATION BOOTSTRAP ERROR · ${Cause.pretty(bootstrapExit.cause)}`,
			}

		const configExit = yield* Effect.exit(loadFoldConfigOrNull(options))
		if (Exit.isFailure(configExit))
			return {
				config: null,
				notice: `CONFIGURATION ERROR · ${Cause.pretty(configExit.cause)}`,
			}

		return {
			config: configExit.value,
			notice:
				configExit.value === null
					? 'NO MODEL CONFIGURATION · RUN `foldcode config init`, THEN EDIT ~/.fold/config.jsonc'
					: null,
		}
	})
