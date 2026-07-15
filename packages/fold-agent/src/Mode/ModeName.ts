/**
 * This file is the mode registry (D26/D27): the stable names a CLI/OpenTUI may select and their
 * mapping to `FoldMode` values. Deliberately data-shaped - adding a mode is adding a name and a Record
 * entry, nothing else. `rpi` arrives when that mode exists.
 */
import { defaultCodingMode, type FoldMode } from './Mode'
import { rlmMode } from './Rlm'

/** The selectable mode names. */
export const FOLD_MODE_NAMES = ['default', 'rlm'] as const

/** A selectable mode name (`default` = the full coding toolset, `rlm` = the delegating orchestrator). */
export type FoldModeName = (typeof FOLD_MODE_NAMES)[number]

const modesByName: Record<FoldModeName, FoldMode> = {
	default: defaultCodingMode,
	rlm: rlmMode,
}

/** Resolve a selectable mode name to its `FoldMode` value. */
export const modeForName = (name: FoldModeName): FoldMode => modesByName[name]
