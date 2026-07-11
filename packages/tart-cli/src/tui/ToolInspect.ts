type UnknownRecord = Readonly<Record<string, unknown>>

const parseRecord = (text: string | null): UnknownRecord | null => {
	if (text === null) return null
	try {
		const value: unknown = JSON.parse(text)
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value))
			: null
	} catch {
		return null
	}
}

const lines = (text: string): ReadonlyArray<string> => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

const hunk = (oldText: string, newText: string): string => {
	const oldLines = lines(oldText)
	const newLines = lines(newText)
	return [
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
		...oldLines.map((line) => `-${line}`),
		...newLines.map((line) => `+${line}`),
	].join('\n')
}

const addedFileDiff = (path: string, content: string): string => {
	const contentLines = content.length === 0 ? [] : lines(content)
	return [
		`--- /dev/null`,
		`+++ b/${path}`,
		`@@ -0,0 +1,${contentLines.length} @@`,
		...contentLines.map((line) => `+${line}`),
	].join('\n')
}

const editDiff = (input: UnknownRecord): string | null => {
	const path = typeof input.path === 'string' ? input.path : 'edited-file'
	const pairs: Array<{ readonly oldText: string; readonly newText: string }> = []
	if (Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (
				typeof edit === 'object' &&
				edit !== null &&
				'oldText' in edit &&
				typeof edit.oldText === 'string' &&
				'newText' in edit &&
				typeof edit.newText === 'string'
			) {
				pairs.push({ oldText: edit.oldText, newText: edit.newText })
			}
		}
	} else if (typeof input.oldText === 'string' && typeof input.newText === 'string') {
		pairs.push({ oldText: input.oldText, newText: input.newText })
	}
	if (pairs.length === 0) return null
	return [`--- a/${path}`, `+++ b/${path}`, ...pairs.map(({ oldText, newText }) => hunk(oldText, newText))].join('\n')
}

const v4aDiffs = (patchText: string): ReadonlyArray<string> => {
	const patchLines = lines(patchText)
	const sections: Array<string> = []
	let index = 0
	while (index < patchLines.length) {
		const line = patchLines[index] ?? ''
		if (line.startsWith('*** Add File:')) {
			const path = line.slice('*** Add File:'.length).trim()
			const content: Array<string> = []
			index += 1
			while (index < patchLines.length && !(patchLines[index] ?? '').startsWith('***')) {
				const contentLine = patchLines[index] ?? ''
				if (contentLine.startsWith('+')) content.push(contentLine.slice(1))
				index += 1
			}
			sections.push(addedFileDiff(path, content.join('\n')))
			continue
		}
		if (line.startsWith('*** Delete File:')) {
			const path = line.slice('*** Delete File:'.length).trim()
			sections.push([`--- a/${path}`, '+++ /dev/null', '@@ -1,1 +0,0 @@', '-(deleted file)'].join('\n'))
			index += 1
			continue
		}
		if (line.startsWith('*** Update File:')) {
			const path = line.slice('*** Update File:'.length).trim()
			let destination = path
			const chunks: Array<{ readonly oldText: string; readonly newText: string }> = []
			let oldLines: Array<string> = []
			let newLines: Array<string> = []
			const flush = (): void => {
				if (oldLines.length === 0 && newLines.length === 0) return
				chunks.push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') })
				oldLines = []
				newLines = []
			}
			index += 1
			if ((patchLines[index] ?? '').startsWith('*** Move to:')) {
				destination = (patchLines[index] ?? '').slice('*** Move to:'.length).trim()
				index += 1
			}
			while (index < patchLines.length && !(patchLines[index] ?? '').startsWith('***')) {
				const bodyLine = patchLines[index] ?? ''
				if (bodyLine.startsWith('@@')) flush()
				else if (bodyLine.startsWith('+')) newLines.push(bodyLine.slice(1))
				else if (bodyLine.startsWith('-')) oldLines.push(bodyLine.slice(1))
				else if (bodyLine.startsWith(' ')) {
					oldLines.push(bodyLine.slice(1))
					newLines.push(bodyLine.slice(1))
				}
				index += 1
			}
			flush()
			sections.push(
				[
					`--- a/${path}`,
					`+++ b/${destination}`,
					...chunks.map((chunk) => hunk(chunk.oldText, chunk.newText)),
				].join('\n'),
			)
			continue
		}
		index += 1
	}
	return sections
}

const splitUnifiedDiff = (text: string): ReadonlyArray<string> => {
	const source = text.trim()
	if (!source.includes('\ndiff --git ')) return [source]
	return source
		.split(/(?=^diff --git )/m)
		.map((section) => section.trim())
		.filter((section) => section.length > 0)
}

const patchDiffs = (patchText: string): ReadonlyArray<string> => {
	const normalized = patchText.trim()
	if (normalized.startsWith('diff --git ') || normalized.startsWith('--- ')) return splitUnifiedDiff(normalized)
	return v4aDiffs(normalized)
}

export const diffsForTool = (toolName: string | null, inputText: string | null): ReadonlyArray<string> => {
	const input = parseRecord(inputText)
	if (input === null) return []
	switch (toolName) {
		case 'write':
			return typeof input.path === 'string' && typeof input.content === 'string'
				? [addedFileDiff(input.path, input.content)]
				: []
		case 'edit': {
			const diff = editDiff(input)
			return diff === null ? [] : [diff]
		}
		case 'apply_patch':
			return typeof input.patch_text === 'string' ? patchDiffs(input.patch_text) : []
		default:
			return []
	}
}

export const diffForTool = (toolName: string | null, inputText: string | null): string | null =>
	diffsForTool(toolName, inputText)[0] ?? null

export const skillMarkdown = (resultText: string | null): string | null => {
	if (resultText === null) return null
	const wrapped = resultText.match(/<skill\b[^>]*>\n([\s\S]*?)\n<\/skill>/)
	const body = wrapped?.[1]?.trim() ?? resultText.trim()
	return body.replace(
		/^Relative paths referenced by this skill \(references\/, scripts\/, \.\.\.\) resolve against [^\n]+\.\n\n/,
		'',
	)
}

export const diffHeight = (diff: string): number => Math.max(4, lines(diff).length + 1)
