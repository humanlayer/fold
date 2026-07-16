import { join } from 'node:path'

export const root = join(import.meta.dirname, '../..')
export const stage = join(root, '.release')
export const libraries = [
	'effect-branded-id',
	'fold-core',
	'fold-codex',
	'fold-opencode',
	'fold-xai',
	'fold-agent',
	'fold-tui-theme',
	'fold-cli',
] as const
export const internal = new Set(['@humanlayer/fold-vitest-config'])

export const targets = [
	['linux', 'arm64', ''],
	['linux', 'x64', ''],
	['linux', 'x64', 'baseline'],
	['linux', 'arm64', 'musl'],
	['linux', 'x64', 'musl'],
	['linux', 'x64', 'baseline-musl'],
	['darwin', 'arm64', ''],
	['darwin', 'x64', ''],
	['darwin', 'x64', 'baseline'],
	['windows', 'arm64', ''],
	['windows', 'x64', ''],
	['windows', 'x64', 'baseline'],
] as const

export const targetName = ([os, cpu, variant]: (typeof targets)[number]) =>
	`@humanlayer/fold-${os}-${cpu}${variant ? `-${variant}` : ''}`

export async function json<T extends object = Record<string, unknown>>(path: string): Promise<T> {
	return Bun.file(path).json()
}
