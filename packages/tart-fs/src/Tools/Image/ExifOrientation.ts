/**
 * This file ports pi's EXIF orientation handling: read the orientation tag (0x0112) from JPEG APP1 or
 * WebP EXIF chunks and apply the corresponding flips/rotations with photon so resized images render
 * upright. Flips mutate in place; rotations return a new image (the caller frees the old one).
 */
import type { Photon, PhotonImage } from './Photon'

const hasExifHeader = (bytes: Uint8Array, offset: number): boolean =>
	bytes[offset] === 0x45 &&
	bytes[offset + 1] === 0x78 &&
	bytes[offset + 2] === 0x69 &&
	bytes[offset + 3] === 0x66 &&
	bytes[offset + 4] === 0x00 &&
	bytes[offset + 5] === 0x00

const readOrientationFromTiff = (bytes: Uint8Array, tiffStart: number): number => {
	if (tiffStart + 8 > bytes.length) return 1

	const littleEndian = (((bytes[tiffStart] ?? 0) << 8) | (bytes[tiffStart + 1] ?? 0)) === 0x4949
	const read16 = (position: number): number =>
		littleEndian
			? (bytes[position] ?? 0) | ((bytes[position + 1] ?? 0) << 8)
			: ((bytes[position] ?? 0) << 8) | (bytes[position + 1] ?? 0)
	const read32 = (position: number): number =>
		littleEndian
			? ((bytes[position] ?? 0) |
					((bytes[position + 1] ?? 0) << 8) |
					((bytes[position + 2] ?? 0) << 16) |
					((bytes[position + 3] ?? 0) << 24)) >>>
				0
			: (((bytes[position] ?? 0) << 24) |
					((bytes[position + 1] ?? 0) << 16) |
					((bytes[position + 2] ?? 0) << 8) |
					(bytes[position + 3] ?? 0)) >>>
				0

	const ifdStart = tiffStart + read32(tiffStart + 4)
	if (ifdStart + 2 > bytes.length) return 1

	const entryCount = read16(ifdStart)
	for (let index = 0; index < entryCount; index += 1) {
		const entryPosition = ifdStart + 2 + index * 12
		if (entryPosition + 12 > bytes.length) return 1
		if (read16(entryPosition) === 0x0112) {
			const value = read16(entryPosition + 8)
			return value >= 1 && value <= 8 ? value : 1
		}
	}

	return 1
}

const findJpegTiffOffset = (bytes: Uint8Array): number => {
	let offset = 2
	while (offset < bytes.length - 1) {
		if (bytes[offset] !== 0xff) return -1
		const marker = bytes[offset + 1]
		if (marker === 0xff) {
			offset += 1
			continue
		}

		if (marker === 0xe1) {
			const segmentStart = offset + 4
			if (offset + 4 >= bytes.length || segmentStart + 6 > bytes.length) return -1
			if (!hasExifHeader(bytes, segmentStart)) return -1
			return segmentStart + 6
		}

		if (offset + 4 > bytes.length) return -1
		offset += 2 + (((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0))
	}

	return -1
}

const findWebpTiffOffset = (bytes: Uint8Array): number => {
	let offset = 12
	while (offset + 8 <= bytes.length) {
		const chunkId = String.fromCharCode(
			bytes[offset] ?? 0,
			bytes[offset + 1] ?? 0,
			bytes[offset + 2] ?? 0,
			bytes[offset + 3] ?? 0,
		)
		const chunkSize =
			(bytes[offset + 4] ?? 0) |
			((bytes[offset + 5] ?? 0) << 8) |
			((bytes[offset + 6] ?? 0) << 16) |
			((bytes[offset + 7] ?? 0) << 24)
		const dataStart = offset + 8

		if (chunkId === 'EXIF') {
			if (dataStart + chunkSize > bytes.length) return -1
			// Some WebP files prefix the TIFF header with "Exif\0\0".
			return chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart
		}

		// RIFF chunks are padded to even sizes.
		offset = dataStart + chunkSize + (chunkSize % 2)
	}

	return -1
}

/** Read the EXIF orientation (1-8) from JPEG or WebP bytes; 1 when absent or unreadable. */
export const exifOrientation = (bytes: Uint8Array): number => {
	let tiffOffset = -1

	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		tiffOffset = findJpegTiffOffset(bytes)
	} else if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		tiffOffset = findWebpTiffOffset(bytes)
	}

	return tiffOffset === -1 ? 1 : readOrientationFromTiff(bytes, tiffOffset)
}

type DstIndex = (x: number, y: number, width: number, height: number) => number

const rotate90 = (photon: Photon, image: PhotonImage, dstIndex: DstIndex): PhotonImage => {
	const width = image.get_width()
	const height = image.get_height()
	const source = image.get_raw_pixels()
	const destination = new Uint8Array(source.length)

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const sourceIndex = (y * width + x) * 4
			const destinationIndex = dstIndex(x, y, width, height) * 4
			destination[destinationIndex] = source[sourceIndex] ?? 0
			destination[destinationIndex + 1] = source[sourceIndex + 1] ?? 0
			destination[destinationIndex + 2] = source[sourceIndex + 2] ?? 0
			destination[destinationIndex + 3] = source[sourceIndex + 3] ?? 0
		}
	}

	return new photon.PhotonImage(destination, height, width)
}

/** Apply the EXIF orientation to a decoded image. Rotations return a NEW image; flips mutate. */
export const applyExifOrientation = (photon: Photon, image: PhotonImage, originalBytes: Uint8Array): PhotonImage => {
	switch (exifOrientation(originalBytes)) {
		case 2:
			photon.fliph(image)
			return image
		case 3:
			photon.fliph(image)
			photon.flipv(image)
			return image
		case 4:
			photon.flipv(image)
			return image
		case 5: {
			const rotated = rotate90(photon, image, (x, y, _width, height) => x * height + (height - 1 - y))
			photon.fliph(rotated)
			return rotated
		}
		case 6:
			return rotate90(photon, image, (x, y, _width, height) => x * height + (height - 1 - y))
		case 7: {
			const rotated = rotate90(photon, image, (x, y, width, height) => (width - 1 - x) * height + y)
			photon.fliph(rotated)
			return rotated
		}
		case 8:
			return rotate90(photon, image, (x, y, width, height) => (width - 1 - x) * height + y)
		default:
			return image
	}
}
