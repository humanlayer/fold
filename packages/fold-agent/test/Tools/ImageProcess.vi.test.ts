import { expect, it } from '@effect/vitest'
/**
 * The image pipeline through its public Effect: real photon for pass-through, conversion, resizing, and
 * decode failures; a photon whose encoders always overshoot the cap for `too-large`; and a photon that
 * failed to load for `unavailable`. Every failure maps to pi's verbatim "[Image omitted: ...]" note.
 */
import * as PhotonNode from '@silvia-odwyer/photon-node'
import { Effect, Layer, Ref } from 'effect'

import { ImageProcessError, imageOmittedNote, processImage } from '../../src/index'
import { Photon } from '../../src/Tools/Image/Photon'

const onePixelPngBase64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A solid PNG of the given size, encoded by photon itself. */
const solidPng = (width: number, height: number): Uint8Array => {
	const image = new PhotonNode.PhotonImage(new Uint8Array(width * height * 4).fill(200), width, height)
	const bytes = image.get_bytes()
	image.free()
	return bytes
}

/** Minimal valid 1x1 24-bit BMP. */
const onePixelBmp = (): Uint8Array => {
	const bytes = new Uint8Array(58)
	const view = new DataView(bytes.buffer)
	bytes[0] = 0x42
	bytes[1] = 0x4d
	view.setUint32(2, 58, true)
	view.setUint32(10, 54, true)
	view.setUint32(14, 40, true)
	view.setInt32(18, 1, true)
	view.setInt32(22, 1, true)
	view.setUint16(26, 1, true)
	view.setUint16(28, 24, true)
	view.setUint32(34, 4, true)
	bytes[54] = 0xff
	return bytes
}

it.effect('passes a small image through unchanged', () =>
	Effect.gen(function* () {
		const processed = yield* processImage(Buffer.from(onePixelPngBase64, 'base64'), 'image/png')
		expect(processed).toEqual({ data: onePixelPngBase64, mimeType: 'image/png', hints: [] })
	}).pipe(Effect.provide(Photon.layer)),
)

it.effect('converts BMP to PNG with a conversion hint', () =>
	Effect.gen(function* () {
		const processed = yield* processImage(onePixelBmp(), 'image/bmp')
		expect(processed.mimeType).toBe('image/png')
		expect(processed.hints).toEqual(['[Image converted from image/bmp to image/png.]'])
		expect(Buffer.from(processed.data, 'base64').subarray(1, 4).toString()).toBe('PNG')
	}).pipe(Effect.provide(Photon.layer)),
)

it.effect('resizes an image wider than 2000px and reports the scale', () =>
	Effect.gen(function* () {
		const processed = yield* processImage(solidPng(4000, 10), 'image/png')
		expect(processed.mimeType).toBe('image/png')
		expect(processed.hints).toEqual([
			'[Image: original 4000x10, displayed at 2000x5. Multiply coordinates by 2.00 to map to original image.]',
		])
	}).pipe(Effect.provide(Photon.layer)),
)

it.effect('fails with decode-failed for bytes photon cannot read', () =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(processImage(new Uint8Array([1, 2, 3, 4]), 'image/png'))
		expect(error).toBeInstanceOf(ImageProcessError)
		expect({ stage: error.stage, reason: error.reason }).toEqual({ stage: 'resize', reason: 'decode-failed' })
		expect(imageOmittedNote(error)).toBe('[Image omitted: could not be resized below the inline image size limit.]')
	}).pipe(Effect.provide(Photon.layer)),
)

it.effect('fails with too-large when no encoding fits, after downscaling to 1x1', () =>
	Effect.gen(function* () {
		const resizes = yield* Ref.make<ReadonlyArray<string>>([])
		// Real photon, except every encoding is one byte over the base64 cap.
		const oversized = new Uint8Array(Math.ceil((4.5 * 1024 * 1024) / 4) * 3 + 3)
		const overshootingPhoton = Layer.effect(
			Photon,
			Effect.gen(function* () {
				const real = yield* Photon
				return Photon.of({
					...real,
					resize: (image, width, height) =>
						Ref.update(resizes, (seen) => [...seen, `${width}x${height}`]).pipe(
							Effect.andThen(real.resize(image, width, height)),
						),
					encodePng: () => Effect.succeed(oversized),
					encodeJpeg: () => Effect.succeed(oversized),
				})
			}),
		).pipe(Layer.provide(Photon.layer))

		const error = yield* Effect.flip(processImage(solidPng(2001, 1), 'image/png')).pipe(
			Effect.provide(overshootingPhoton),
		)
		expect({ stage: error.stage, reason: error.reason }).toEqual({ stage: 'resize', reason: 'too-large' })
		expect(imageOmittedNote(error)).toBe('[Image omitted: could not be resized below the inline image size limit.]')
		const seen = yield* Ref.get(resizes)
		expect(seen[0]).toBe('2000x1')
		expect(seen.at(-1)).toBe('1x1')
	}),
)

it.effect('fails with unavailable when photon did not load, keeping the stage note', () =>
	Effect.gen(function* () {
		const convertError = yield* Effect.flip(processImage(onePixelBmp(), 'image/bmp'))
		expect({ stage: convertError.stage, reason: convertError.reason }).toEqual({
			stage: 'convert',
			reason: 'unavailable',
		})
		expect(convertError.cause?.cause).toBe('wasm load failed')
		expect(imageOmittedNote(convertError)).toBe(
			'[Image omitted: could not be converted to a supported inline image format.]',
		)

		const resizeError = yield* Effect.flip(processImage(Buffer.from(onePixelPngBase64, 'base64'), 'image/png'))
		expect({ stage: resizeError.stage, reason: resizeError.reason }).toEqual({
			stage: 'resize',
			reason: 'unavailable',
		})
		expect(imageOmittedNote(resizeError)).toBe(
			'[Image omitted: could not be resized below the inline image size limit.]',
		)
	}).pipe(Effect.provide(Photon.layerUnavailable('wasm load failed'))),
)
