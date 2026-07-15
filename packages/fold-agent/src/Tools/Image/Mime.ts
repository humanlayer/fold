/**
 * This file ports pi's image magic-byte sniffing (D18): jpeg/png/gif/webp/bmp detected from the first
 * bytes; animated PNG and JPEG-LS explicitly rejected (providers cannot render them inline); anything
 * unrecognized returns null and the read tool falls through to the text path.
 */

/** Number of leading bytes sufficient for every supported signature check. */
export const imageSniffBytes = 4100

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean => {
	for (let index = 0; index < text.length; index += 1) {
		if (bytes[offset + index] !== text.charCodeAt(index)) return false
	}
	return true
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const isPng = (bytes: Uint8Array): boolean => {
	if (bytes.length < 16) return false
	for (const [index, expected] of pngSignature.entries()) {
		if (bytes[index] !== expected) return false
	}
	const ihdrLength = ((bytes[8] ?? 0) << 24) | ((bytes[9] ?? 0) << 16) | ((bytes[10] ?? 0) << 8) | (bytes[11] ?? 0)
	return ihdrLength === 13 && ascii(bytes, 12, 'IHDR')
}

/** Walk PNG chunks: an acTL chunk before IDAT marks an animated PNG (rejected - pi parity). */
const isAnimatedPng = (bytes: Uint8Array): boolean => {
	let offset = 8
	while (offset + 8 <= bytes.length) {
		const length =
			((bytes[offset] ?? 0) << 24) |
			((bytes[offset + 1] ?? 0) << 16) |
			((bytes[offset + 2] ?? 0) << 8) |
			(bytes[offset + 3] ?? 0)
		if (ascii(bytes, offset + 4, 'acTL')) return true
		if (ascii(bytes, offset + 4, 'IDAT')) return false
		offset += 12 + length
	}
	return false
}

const isBmp = (bytes: Uint8Array): boolean => {
	if (bytes.length < 26) return false

	const dibHeaderSize =
		(bytes[14] ?? 0) | ((bytes[15] ?? 0) << 8) | ((bytes[16] ?? 0) << 16) | ((bytes[17] ?? 0) << 24)
	if (dibHeaderSize !== 12 && (dibHeaderSize < 40 || dibHeaderSize > 124)) return false

	if (dibHeaderSize === 12) return true

	const colorPlanes = (bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)
	const bitsPerPixel = (bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel)
}

/**
 * Detect a supported image MIME type from leading bytes; null routes the file to the text path.
 * Rejections (null despite an image signature): JPEG-LS (4th byte 0xF7) and animated PNG.
 */
export const detectSupportedImageMimeType = (bytes: Uint8Array): string | null => {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return bytes[3] === 0xf7 ? null : 'image/jpeg'
	}
	if (isPng(bytes)) return isAnimatedPng(bytes) ? null : 'image/png'
	if (ascii(bytes, 0, 'GIF')) return 'image/gif'
	if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp'
	if (bytes.length >= 2 && ascii(bytes, 0, 'BM') && isBmp(bytes)) return 'image/bmp'
	return null
}
