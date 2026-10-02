/**
 * This file wraps the photon WASM image library (pi's choice: pure Rust-to-WASM, no native addon) as
 * the `Photon` service. Its layer loads the module once; a load failure does not fail the layer, it
 * yields a service whose operations fail with `PhotonError` reason `unavailable`, so the read tool
 * can fall back to its "image omitted" note instead of crashing the run. Every photon image an
 * operation creates is freed when the caller's scope closes.
 */
import type * as PhotonNode from '@silvia-odwyer/photon-node'
import { Context, Data, Effect, Layer, type Scope } from 'effect'

import { applyExifOrientation } from './ExifOrientation'

export type PhotonModule = typeof PhotonNode

/** The subset of photon's PhotonImage surface the resize pipeline touches. */
export type PhotonImage = InstanceType<PhotonModule['PhotonImage']>

/** Why a photon operation failed; `unavailable` means the WASM module could not be loaded. */
export type PhotonFailureReason = 'unavailable' | 'decode-failed' | 'orient-failed' | 'resize-failed' | 'encode-failed'

export class PhotonError extends Data.TaggedError('PhotonError')<{
	readonly reason: PhotonFailureReason
	readonly cause: unknown
}> {}

type PhotonService = {
	/** Decode image bytes; the image is freed when the scope closes. */
	readonly decode: (bytes: Uint8Array) => Effect.Effect<PhotonImage, PhotonError, Scope.Scope>
	/** Apply the EXIF orientation of `originalBytes`; a rotated copy is freed when the scope closes. */
	readonly orient: (
		image: PhotonImage,
		originalBytes: Uint8Array,
	) => Effect.Effect<PhotonImage, PhotonError, Scope.Scope>
	/** Lanczos3 resize into a new image, freed when the scope closes. */
	readonly resize: (
		image: PhotonImage,
		width: number,
		height: number,
	) => Effect.Effect<PhotonImage, PhotonError, Scope.Scope>
	readonly encodePng: (image: PhotonImage) => Effect.Effect<Uint8Array, PhotonError>
	readonly encodeJpeg: (image: PhotonImage, quality: number) => Effect.Effect<Uint8Array, PhotonError>
}

const freeOnRelease = (image: PhotonImage): Effect.Effect<void> => Effect.sync(() => image.free())

const fromModule = (photon: PhotonModule): PhotonService => ({
	decode: Effect.fn('Photon.decode')((bytes: Uint8Array) =>
		Effect.acquireRelease(
			Effect.try({
				try: () => photon.PhotonImage.new_from_byteslice(bytes),
				catch: (cause) => new PhotonError({ reason: 'decode-failed', cause }),
			}),
			freeOnRelease,
		),
	),
	orient: Effect.fn('Photon.orient')((image: PhotonImage, originalBytes: Uint8Array) =>
		Effect.acquireRelease(
			Effect.try({
				try: () => applyExifOrientation(photon, image, originalBytes),
				catch: (cause) => new PhotonError({ reason: 'orient-failed', cause }),
			}),
			// Flips mutate `image` in place; only a rotated copy is a new image this scope owns.
			(oriented) => (oriented === image ? Effect.void : freeOnRelease(oriented)),
		),
	),
	resize: Effect.fn('Photon.resize')((image: PhotonImage, width: number, height: number) =>
		Effect.acquireRelease(
			Effect.try({
				try: () => photon.resize(image, width, height, photon.SamplingFilter.Lanczos3),
				catch: (cause) => new PhotonError({ reason: 'resize-failed', cause }),
			}),
			freeOnRelease,
		),
	),
	encodePng: Effect.fn('Photon.encodePng')((image: PhotonImage) =>
		Effect.try({
			try: () => image.get_bytes(),
			catch: (cause) => new PhotonError({ reason: 'encode-failed', cause }),
		}),
	),
	encodeJpeg: Effect.fn('Photon.encodeJpeg')((image: PhotonImage, quality: number) =>
		Effect.try({
			try: () => image.get_bytes_jpeg(quality),
			catch: (cause) => new PhotonError({ reason: 'encode-failed', cause }),
		}),
	),
})

/** A service whose every operation fails with the load failure. */
const unavailable = (error: PhotonError): PhotonService => ({
	decode: () => Effect.fail(error),
	orient: () => Effect.fail(error),
	resize: () => Effect.fail(error),
	encodePng: () => Effect.fail(error),
	encodeJpeg: () => Effect.fail(error),
})

export class Photon extends Context.Service<Photon, PhotonService>()('fold-agent/Tools/Image/Photon') {
	/** Load photon once; a load failure yields a service whose operations fail with `unavailable`. */
	static readonly layer = Layer.effect(
		Photon,
		Effect.tryPromise({
			try: () => import('@silvia-odwyer/photon-node'),
			catch: (cause) => new PhotonError({ reason: 'unavailable', cause }),
		}).pipe(
			Effect.map(fromModule),
			Effect.catchTag('PhotonError', (error) =>
				Effect.logWarning('photon image library unavailable; images will be omitted', error.cause).pipe(
					Effect.as(unavailable(error)),
				),
			),
		),
	)

	/** A photon that failed to load with `cause`: every operation fails with reason `unavailable`. */
	static readonly layerUnavailable = (cause: unknown): Layer.Layer<Photon> =>
		Layer.succeed(Photon, unavailable(new PhotonError({ reason: 'unavailable', cause })))
}
