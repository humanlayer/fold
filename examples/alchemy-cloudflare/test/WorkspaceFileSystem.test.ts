/**
 * The workspace FileSystem against an in-memory Computer that fails the way the real one does: with a
 * code such as `ENOENT` in a result value. fold's disk skill loader then runs over it unchanged.
 */
import { it } from '@effect/vitest'
import { makeDiskSkillSource } from '@humanlayer/fold-agent/skills'
import { fileTools, Photon } from '@humanlayer/fold-agent/tools/files'
import type { FoldTool } from '@humanlayer/fold-core'
import { Effect, FileSystem, Layer, Path, type PlatformError } from 'effect'
import { expect } from 'vitest'

import type { FileInfo, ComputerResult } from '../src/computer/Contract'
import { type ComputerFiles, workspaceFileSystem } from '../src/WorkspaceFileSystem'
import { callTool } from './ToolCalls'

type Node = { readonly type: 'Directory' } | { readonly type: 'File'; readonly content: Uint8Array }

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

const fakeComputer = (): ComputerFiles => {
	const nodes = new Map<string, Node>([['/', { type: 'Directory' }]])
	const ok = <A>(value: A): Effect.Effect<ComputerResult<A>> => Effect.succeed({ ok: true, value })
	const fail = (code: string, path: string): Effect.Effect<ComputerResult<never>> =>
		Effect.succeed({ ok: false, code, message: `${code}: ${path}` })
	const children = (path: string) =>
		[...nodes.keys()]
			.filter((child) => child !== '/' && parentOf(child) === path)
			.map((child) => child.slice(path.length).replace(/^\//, ''))

	return {
		readFile: (path) => {
			const node = nodes.get(path)
			if (node === undefined) return fail('ENOENT', path)
			return node.type === 'File' ? ok(node.content) : fail('EISDIR', path)
		},
		writeFile: (path, content) => {
			if (nodes.get(parentOf(path))?.type !== 'Directory') return fail('ENOENT', path)
			nodes.set(path, { type: 'File', content: new TextEncoder().encode(content) })
			return ok(null)
		},
		mkdir: (path, recursive) => {
			if (nodes.has(path)) return recursive ? ok(null) : fail('EEXIST', path)
			if (!nodes.has(parentOf(path)) && !recursive) return fail('ENOENT', path)
			for (let dir = path; !nodes.has(dir); dir = parentOf(dir)) nodes.set(dir, { type: 'Directory' })
			return ok(null)
		},
		rm: (path, recursive, force) => {
			if (!nodes.has(path)) return force ? ok(null) : fail('ENOENT', path)
			if (children(path).length > 0 && !recursive) return fail('ENOTEMPTY', path)
			for (const key of nodes.keys()) if (key === path || key.startsWith(`${path}/`)) nodes.delete(key)
			return ok(null)
		},
		stat: (path) => {
			const node = nodes.get(path)
			if (node === undefined) return fail('ENOENT', path)
			const info: FileInfo = {
				type: node.type,
				size: node.type === 'File' ? node.content.length : 0,
				mtime: 0,
				mode: 0o644,
				inode: 1,
			}
			return ok(info)
		},
		readdir: (path) => {
			const node = nodes.get(path)
			if (node === undefined) return fail('ENOENT', path)
			return node.type === 'Directory' ? ok(children(path).sort()) : fail('ENOTDIR', path)
		},
	}
}

/** Call one of fold's tools with the workspace as its FileSystem. */
const call = (
	fs: FileSystem.FileSystem,
	tools: ReadonlyArray<FoldTool<FileSystem.FileSystem | Path.Path | Photon>>,
	name: string,
	params: unknown,
) =>
	callTool(tools, name, params).pipe(
		Effect.provideService(FileSystem.FileSystem, fs),
		Effect.provide(Layer.mergeAll(Path.layer, Photon.layer)),
	)

const reasonTag = (error: PlatformError.PlatformError) => error.reason._tag

it.effect('writes, reads, lists, and removes files', () =>
	Effect.gen(function* () {
		const fs = workspaceFileSystem(fakeComputer())

		yield* fs.makeDirectory('/workspace/app/src', { recursive: true })
		yield* fs.writeFileString('/workspace/app/src/index.ts', 'export {}\n')

		expect(yield* fs.readFileString('/workspace/app/src/index.ts')).toBe('export {}\n')
		expect(yield* fs.readDirectory('/workspace/app')).toEqual(['src'])
		expect((yield* fs.stat('/workspace/app/src')).type).toBe('Directory')
		expect(yield* fs.exists('/workspace/app/src/index.ts')).toBe(true)
		expect(yield* fs.realPath('/workspace/app/src/index.ts')).toBe('/workspace/app/src/index.ts')

		yield* fs.remove('/workspace/app', { recursive: true })
		expect(yield* fs.exists('/workspace/app')).toBe(false)
	}),
)

it.effect("maps the Computer's error codes to platform errors that keep the code", () =>
	Effect.gen(function* () {
		const fs = workspaceFileSystem(fakeComputer())
		yield* fs.makeDirectory('/workspace')

		const missing = yield* Effect.flip(fs.readFile('/workspace/nope.txt'))
		expect(reasonTag(missing)).toBe('NotFound')
		expect(missing.reason.cause).toEqual({ code: 'ENOENT' })

		expect(reasonTag(yield* Effect.flip(fs.readFile('/workspace')))).toBe('BadResource')
		expect(reasonTag(yield* Effect.flip(fs.access('/workspace/nope.txt')))).toBe('NotFound')
		expect(reasonTag(yield* Effect.flip(fs.writeFileString('/nowhere/file.txt', '')))).toBe('NotFound')
		expect(reasonTag(yield* Effect.flip(fs.makeDirectory('/workspace')))).toBe('AlreadyExists')
	}),
)

it.effect("fold's skill loader finds a repo's skills on the workspace", () =>
	Effect.gen(function* () {
		const fs = workspaceFileSystem(fakeComputer())
		yield* fs.makeDirectory('/workspace/app/.claude/skills/deploy', { recursive: true })
		yield* fs.writeFileString(
			'/workspace/app/.claude/skills/deploy/SKILL.md',
			'---\nname: deploy\ndescription: Ship the app.\n---\nRun the deploy.\n',
		)

		const skills = yield* makeDiskSkillSource({
			cwd: '/workspace',
			home: '/root',
			extraPaths: ['/workspace/app/.claude/skills', '/workspace/app/.agents/skills'],
		}).pipe(Effect.provideService(FileSystem.FileSystem, fs))

		expect(yield* skills.list).toEqual([{ name: 'deploy', description: 'Ship the app.' }])
		expect((yield* skills.load('deploy')).content).toBe('Run the deploy.')
	}),
)

it.effect("fold's file tools write, edit, patch and read files on the workspace", () =>
	Effect.gen(function* () {
		const fs = workspaceFileSystem(fakeComputer())
		const tools = fileTools({ cwd: '/workspace' })
		yield* fs.makeDirectory('/workspace/app', { recursive: true })

		yield* call(fs, tools, 'write', { path: 'app/notes.md', content: 'one\ntwo\n' })
		yield* call(fs, tools, 'edit', { path: 'app/notes.md', edits: [{ oldText: 'two', newText: 'three' }] })
		yield* call(fs, tools, 'apply_patch', {
			patch_text: '*** Begin Patch\n*** Add File: app/new/added.md\n+added\n*** End Patch',
		})

		expect(yield* fs.readFileString('/workspace/app/notes.md')).toBe('one\nthree\n')
		expect(yield* fs.readFileString('/workspace/app/new/added.md')).toBe('added\n')
		expect(yield* call(fs, tools, 'read', { path: 'app/notes.md' })).toMatchObject({
			text: expect.stringContaining('three'),
		})
		expect(yield* Effect.flip(call(fs, tools, 'read', { path: 'app/missing.md' }))).toMatchObject({
			text: expect.stringContaining('file not found'),
		})
	}),
)
