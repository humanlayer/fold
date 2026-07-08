/**
 * This file ports pi's image resize/normalize pipeline for the read tool (D18): EXIF-oriented decode,
 * pass-through when already within limits, Lanczos3 resize to 2000x2000, a PNG-then-JPEG-quality
 * encode ladder under the 4.5MB base64 cap (headroom below Anthropic's 5MB inline limit), a 0.75
 * downscale loop as last resort, and BMP-to-PNG conversion. All failures degrade to model-visible
 * "[Image omitted: ...]" notes rather than errors.
 */
import { applyExifOrientation } from './ExifOrientation'
import { loadPhoton } from './Photon'

/** 4.5MB of base64 payload: headroom below Anthropic's 5MB inline image limit (pi parity). */
export const defaultMaxImageBytes = 4.5 * 1024 * 1024

const maxDimension = 2000
const jpegQualityLadder = [80, 85, 70, 55, 40]

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

type ResizedImage = {
	readonly data: string
	readonly mimeType: string
	readonly originalWidth: number
	readonly originalHeight: number
	readonly width: number
	readonly height: number
	readonly wasResized: boolean
}

/** Resize/re-encode to fit dimension and base64-size limits. Null when photon fails or nothing fits. */
const resizeImage = async (inputBytes: Uint8Array, mimeType: string): Promise<ResizedImage | null> => {
	const photon = await loadPhoton()
	if (photon === null) return null

	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4
	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined

	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes)
		image = applyExifOrientation(photon, rawImage, inputBytes)
		if (image !== rawImage) rawImage.free()

		const originalWidth = image.get_width()
		const originalHeight = image.get_height()

		if (originalWidth <= maxDimension && originalHeight <= maxDimension && inputBase64Size < defaultMaxImageBytes) {
			return {
				data: toBase64(inputBytes),
				mimeType,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			}
		}

		let targetWidth = originalWidth
		let targetHeight = originalHeight
		if (targetWidth > maxDimension) {
			targetHeight = Math.round((targetHeight * maxDimension) / targetWidth)
			targetWidth = maxDimension
		}
		if (targetHeight > maxDimension) {
			targetWidth = Math.round((targetWidth * maxDimension) / targetHeight)
			targetHeight = maxDimension
		}

		let currentWidth = targetWidth
		let currentHeight = targetHeight

		while (true) {
			const resized = photon.resize(image, currentWidth, currentHeight, photon.SamplingFilter.Lanczos3)
			try {
				// PNG first, then descending JPEG qualities: first candidate under the cap wins.
				const candidates = [
					{ bytes: resized.get_bytes(), mimeType: 'image/png' },
					...jpegQualityLadder.map((quality) => ({
						bytes: resized.get_bytes_jpeg(quality),
						mimeType: 'image/jpeg',
					})),
				]
				for (const candidate of candidates) {
					const data = toBase64(candidate.bytes)
					if (data.length < defaultMaxImageBytes) {
						return {
							data,
							mimeType: candidate.mimeType,
							originalWidth,
							originalHeight,
							width: currentWidth,
							height: currentHeight,
							wasResized: true,
						}
					}
				}
			} finally {
				resized.free()
			}

			if (currentWidth === 1 && currentHeight === 1) break
			const nextWidth = Math.max(1, Math.floor(currentWidth * 0.75))
			const nextHeight = Math.max(1, Math.floor(currentHeight * 0.75))
			if (nextWidth === currentWidth && nextHeight === currentHeight) break
			currentWidth = nextWidth
			currentHeight = nextHeight
		}

		return null
	} catch {
		return null
	} finally {
		image?.free()
	}
}

/** Decode any photon-readable bytes and re-encode as PNG (the BMP conversion path). */
const convertToPng = async (inputBytes: Uint8Array): Promise<Uint8Array | null> => {
	const photon = await loadPhoton()
	if (photon === null) return null

	try {
		const image = photon.PhotonImage.new_from_byteslice(inputBytes)
		try {
			return image.get_bytes()
		} finally {
			image.free()
		}
	} catch {
		return null
	}
}

const inlineSupportedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Outcome of processing image bytes for a tool result. */
export type ProcessedImage =
	| { readonly ok: true; readonly data: string; readonly mimeType: string; readonly hints: ReadonlyArray<string> }
	| { readonly ok: false; readonly message: string }

/**
 * Prepare sniffed image bytes for inline delivery: convert unsupported containers (BMP) to PNG, then
 * resize/re-encode under the inline limits. Failure messages are pi's, verbatim.
 */
export const processImage = async (inputBytes: Uint8Array, sniffedMimeType: string): Promise<ProcessedImage> => {
	const hints: Array<string> = []
	let bytes = inputBytes
	let mimeType = sniffedMimeType

	if (!inlineSupportedMimeTypes.has(mimeType)) {
		const converted = await convertToPng(bytes)
		if (converted === null) {
			return { ok: false, message: '[Image omitted: could not be converted to a supported inline image format.]' }
		}
		hints.push(`[Image converted from ${mimeType} to image/png.]`)
		bytes = converted
		mimeType = 'image/png'
	}

	const resized = await resizeImage(bytes, mimeType)
	if (resized === null) {
		return { ok: false, message: '[Image omitted: could not be resized below the inline image size limit.]' }
	}

	if (resized.wasResized) {
		const scale = resized.originalWidth / resized.width
		hints.push(
			`[Image: original ${resized.originalWidth}x${resized.originalHeight}, displayed at ${resized.width}x${resized.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`,
		)
	}

	return { ok: true, data: resized.data, mimeType: resized.mimeType, hints }
}
