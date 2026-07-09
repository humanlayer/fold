/**
 * This file is the mode registry (D26/D27): the stable names a CLI/OpenTUI may select and their
 * mapping to `TartMode` values. Deliberately data-shaped - adding a mode is adding a name and a Record
 * entry, nothing else. `rpi` arrives when that mode exists.
 */
import { defaultCodingMode, type TartMode } from './Mode'
import { rlmMode } from './Rlm'

/** The selectable mode names. */
export const TART_MODE_NAMES = ['default', 'rlm'] as const

/** A selectable mode name (`default` = the full coding toolset, `rlm` = the delegating orchestrator). */
export type TartModeName = (typeof TART_MODE_NAMES)[number]

const modesByName: Record<TartModeName, TartMode> = {
	default: defaultCodingMode,
	rlm: rlmMode,
}

/** Resolve a selectable mode name to its `TartMode` value. */
export const modeForName = (name: TartModeName): TartMode => modesByName[name]
