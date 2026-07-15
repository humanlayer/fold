import { describe, expect, it } from '@effect/vitest'

import { formatSize, truncateHead, truncateTail, utf8ByteLength } from '../../src/index'

describe('formatSize', () => {
	it('renders bytes, KB with one decimal, and MB with one decimal (pi parity)', () => {
		expect(formatSize(512)).toBe('512B')
		expect(formatSize(50 * 1024)).toBe('50.0KB')
		expect(formatSize(1536)).toBe('1.5KB')
		expect(formatSize(2 * 1024 * 1024)).toBe('2.0MB')
	})
})

describe('utf8ByteLength', () => {
	it('counts true UTF-8 bytes, not UTF-16 code units', () => {
		expect(utf8ByteLength('abc')).toBe(3)
		expect(utf8ByteLength('é')).toBe(2)
		expect(utf8ByteLength('🎉')).toBe(4)
	})
})

describe('truncateHead', () => {
	it('passes small content through untouched', () => {
		const result = truncateHead('one\ntwo\nthree')

		expect(result.truncated).toBe(false)
		expect(result.content).toBe('one\ntwo\nthree')
		expect(result.outputLines).toBe(3)
		expect(result.totalLines).toBe(3)
	})

	it('keeps the first maxLines lines when the line limit hits first', () => {
		const text = Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n')
		const result = truncateHead(text, { maxLines: 4 })

		expect(result.truncated).toBe(true)
		expect(result.truncatedBy).toBe('lines')
		expect(result.content).toBe('line-0\nline-1\nline-2\nline-3')
		expect(result.outputLines).toBe(4)
		expect(result.totalLines).toBe(10)
	})

	it('keeps whole lines under the byte limit and never emits a partial line', () => {
		const text = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'].join('\n')
		const result = truncateHead(text, { maxBytes: 25 })

		expect(result.truncatedBy).toBe('bytes')
		expect(result.content).toBe('aaaaaaaaaa\nbbbbbbbbbb')
		expect(result.outputLines).toBe(2)
	})

	it('flags an oversized first line and returns empty content (bash redirect case)', () => {
		const result = truncateHead(`${'x'.repeat(100)}\nshort`, { maxBytes: 50 })

		expect(result.firstLineExceedsLimit).toBe(true)
		expect(result.content).toBe('')
		expect(result.outputLines).toBe(0)
		expect(result.totalLines).toBe(2)
	})

	it('a trailing newline terminates the last line: exactly maxLines passes through untouched', () => {
		// pi's splitLinesForCounting: 4 real lines + trailing newline is NOT 5 lines.
		const text = 'a\nb\nc\nd\n'
		const result = truncateHead(text, { maxLines: 4 })

		expect(result.truncated).toBe(false)
		expect(result.content).toBe(text)
		expect(result.totalLines).toBe(4)
	})
})

describe('truncateTail', () => {
	it('keeps the last maxLines lines when the line limit hits first', () => {
		const text = Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n')
		const result = truncateTail(text, { maxLines: 3 })

		expect(result.truncatedBy).toBe('lines')
		expect(result.content).toBe('line-7\nline-8\nline-9')
	})

	it('keeps the last whole lines under the byte limit', () => {
		const text = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'].join('\n')
		const result = truncateTail(text, { maxBytes: 25 })

		expect(result.truncatedBy).toBe('bytes')
		expect(result.content).toBe('bbbbbbbbbb\ncccccccccc')
	})

	it('byte-truncates an oversized final line from the end (errors live at the tail)', () => {
		const result = truncateTail(`short\n${'y'.repeat(100)}`, { maxBytes: 40 })

		expect(result.truncated).toBe(true)
		expect(result.content).toBe('y'.repeat(40))
	})

	it('never splits a multi-byte code point when byte-truncating the final line', () => {
		const result = truncateTail('🎉'.repeat(50), { maxBytes: 10 })

		// 10 bytes / 4 bytes-per-emoji leaves two whole emoji after boundary alignment.
		expect(result.content).toBe('🎉🎉')
	})

	it('detects an oversized final line even when the text ends with a newline', () => {
		// The trailing newline terminates the giant line; it must still trigger the partial case.
		const result = truncateTail(`small\n${'y'.repeat(100)}\n`, { maxBytes: 40 })

		expect(result.lastLinePartial).toBe(true)
		expect(result.content).toBe('y'.repeat(40))
		expect(result.outputLines).toBe(1)
		expect(result.totalLines).toBe(2)
	})
})
