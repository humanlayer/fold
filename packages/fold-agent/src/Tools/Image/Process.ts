/**
 * This file ports pi's image resize/normalize pipeline for the read tool (D18): EXIF-oriented decode,
 * pass-through when already within limits, Lanczos3 resize to 2000x2000, a PNG-then-JPEG-quality
 * encode ladder under the 4.5MB base64 cap (headroom below Anthropic's 5MB inline limit), a 0.75
 * downscale loop as last resort, and BMP-to-PNG conversion. Failures are `ImageProcessError`s; callers
 * turn them into pi's model-visible "[Image omitted: ...]" notes with `imageOmittedNote`.
 */
import { Data, Effect, Match, Option } from 'effect'

import { Photon, type PhotonError, type PhotonFailureReason, type PhotonImage } from './Photon'

/** 4.5MB of base64 payload: headroom below Anthropic's 5MB inline image limit (pi parity). */
export const defaultMaxImageBytes = 4.5 * 1024 * 1024

const maxDimension = 2000
const jpegQualityLadder = [80, 85, 70, 55, 40]

const inlineSupportedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

/**
 * Image processing failed. `stage` says which step failed (converting an unsupported container to PNG,
 * or fitting the image under the inline limits); `too-large` means no encoding fit even at 1x1.
 */
export class ImageProcessError extends Data.TaggedError('ImageProcessError')<{
	readonly stage: 'convert' | 'resize'
	readonly reason: PhotonFailureReason | 'too-large'
	readonly cause?: PhotonError
}> {}

/** pi's verbatim model-visible note for an image that could not be processed. */
export const imageOmittedNote = (error: ImageProcessError): string =>
	Match.value(error.stage).pipe(
		Match.when('convert', () => '[Image omitted: could not be converted to a supported inline image format.]'),
		Match.when('resize', () => '[Image omitted: could not be resized below the inline image size limit.]'),
		Match.exhaustive,
	)

/** An image ready for inline delivery, plus model-visible hints about conversion/resizing. */
export type ProcessedImage = {
	readonly data: string
	readonly mimeType: string
	readonly hints: ReadonlyArray<string>
}

type ResizedImage = {
	readonly data: string
	readonly mimeType: string
	readonly originalWidth: number
	readonly originalHeight: number
	readonly width: number
	readonly height: number
	readonly wasResized: boolean
}

type Encoded = { readonly data: string; readonly mimeType: string }

/** PNG first, then descending JPEG qualities: the first candidate under the cap wins. */
const encodeUnderCap = (image: PhotonImage): Effect.Effect<Option.Option<Encoded>, PhotonError, Photon> =>
	Effect.gen(function* () {
		const photon = yield* Photon
		const candidates = [
			{ encode: photon.encodePng(image), mimeType: 'image/png' },
			...jpegQualityLadder.map((quality) => ({
				encode: photon.encodeJpeg(image, quality),
				mimeType: 'image/jpeg',
			})),
		]
		for (const candidate of candidates) {
			const data = toBase64(yield* candidate.encode)
			if (data.length < defaultMaxImageBytes) return Option.some({ data, mimeType: candidate.mimeType })
		}
		return Option.none()
	})

/** Fit width/height inside maxDimension x maxDimension, preserving aspect ratio. */
const fitWithinMaxDimension = (width: number, height: number) => {
	let targetWidth = width
	let targetHeight = height
	if (targetWidth > maxDimension) {
		targetHeight = Math.round((targetHeight * maxDimension) / targetWidth)
		targetWidth = maxDimension
	}
	if (targetHeight > maxDimension) {
		targetWidth = Math.round((targetWidth * maxDimension) / targetHeight)
		targetHeight = maxDimension
	}
	return { width: targetWidth, height: targetHeight }
}

/** Resize/re-encode to fit dimension and base64-size limits. */
const resizeImage = Effect.fn('resizeImage')(
	function* (inputBytes: Uint8Array, mimeType: string) {
		const photon = yield* Photon
		const image = yield* photon.orient(yield* photon.decode(inputBytes), inputBytes)
		const originalWidth = image.get_width()
		const originalHeight = image.get_height()
		const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4

		if (originalWidth <= maxDimension && originalHeight <= maxDimension && inputBase64Size < defaultMaxImageBytes) {
			const passThrough: ResizedImage = {
				data: toBase64(inputBytes),
				mimeType,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			}
			return passThrough
		}

		let { width, height } = fitWithinMaxDimension(originalWidth, originalHeight)
		while (true) {
			const encoded = yield* Effect.scoped(Effect.flatMap(photon.resize(image, width, height), encodeUnderCap))
			if (Option.isSome(encoded)) {
				const resized: ResizedImage = {
					...encoded.value,
					originalWidth,
					originalHeight,
					width,
					height,
					wasResized: true,
				}
				return resized
			}

			const nextWidth = Math.max(1, Math.floor(width * 0.75))
			const nextHeight = Math.max(1, Math.floor(height * 0.75))
			if (nextWidth === width && nextHeight === height) break
			width = nextWidth
			height = nextHeight
		}

		return yield* new ImageProcessError({ stage: 'resize', reason: 'too-large' })
	},
	Effect.scoped,
	Effect.catchTag('PhotonError', (cause) =>
		Effect.fail(new ImageProcessError({ stage: 'resize', reason: cause.reason, cause })),
	),
)

/** Decode any photon-readable bytes and re-encode as PNG (the BMP conversion path). */
const convertToPng = Effect.fn('convertToPng')(
	function* (inputBytes: Uint8Array) {
		const photon = yield* Photon
		return yield* photon.encodePng(yield* photon.decode(inputBytes))
	},
	Effect.scoped,
	Effect.mapError((cause) => new ImageProcessError({ stage: 'convert', reason: cause.reason, cause })),
)

/**
 * Prepare sniffed image bytes for inline delivery: convert unsupported containers (BMP) to PNG, then
 * resize/re-encode under the inline limits.
 */
export const processImage = Effect.fn('processImage')(function* (inputBytes: Uint8Array, sniffedMimeType: string) {
	const hints: Array<string> = []
	let bytes = inputBytes
	let mimeType = sniffedMimeType

	if (!inlineSupportedMimeTypes.has(mimeType)) {
		bytes = yield* convertToPng(bytes)
		hints.push(`[Image converted from ${mimeType} to image/png.]`)
		mimeType = 'image/png'
	}

	const resized = yield* resizeImage(bytes, mimeType)
	if (resized.wasResized) {
		const scale = resized.originalWidth / resized.width
		hints.push(
			`[Image: original ${resized.originalWidth}x${resized.originalHeight}, displayed at ${resized.width}x${resized.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`,
		)
	}

	const processed: ProcessedImage = { data: resized.data, mimeType: resized.mimeType, hints }
	return processed
})
