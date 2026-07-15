/**
 * This file lazily loads the photon WASM image library (pi's choice: pure Rust-to-WASM, no native
 * addon). Load failures degrade to null so the read tool can fall back to its "image omitted" note
 * instead of crashing the run.
 */

export type Photon = typeof import('@silvia-odwyer/photon-node')

/** The subset of photon's PhotonImage surface the resize pipeline touches. */
export type PhotonImage = InstanceType<Photon['PhotonImage']>

let photon: Photon | null | undefined

/** Load photon once per process; null when the WASM module cannot be loaded. */
export const loadPhoton = async (): Promise<Photon | null> => {
	if (photon !== undefined) return photon

	try {
		photon = await import('@silvia-odwyer/photon-node')
	} catch {
		photon = null
	}

	return photon
}
