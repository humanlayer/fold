import { Layer } from 'effect'

import { layerDeterministicClock, type DeterministicClockOptions } from './DeterministicClock.ts'
import { layerDeterministicIds, type DeterministicIdsOptions } from './DeterministicIds.ts'

export type DeterministicRuntimeOptions = DeterministicIdsOptions & DeterministicClockOptions

export const layerDeterministicRuntime = (options: DeterministicRuntimeOptions = {}) =>
	Layer.mergeAll(layerDeterministicIds(options), layerDeterministicClock(options))
