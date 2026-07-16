#!/usr/bin/env node
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
if (manifest.private) process.exit(0)
const platform = os.platform() === 'win32' ? 'windows' : os.platform()
const arch = os.arch()
const base = `@humanlayer/fold-${platform}-${arch}`
const sourceName = platform === 'windows' ? 'foldcode.exe' : 'foldcode'
const target = path.join(dir, 'bin', 'foldcode.exe')

function supportsAvx2() {
	if (arch !== 'x64') return false
	try {
		if (platform === 'linux') return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync('/proc/cpuinfo', 'utf8'))
		if (platform === 'darwin') {
			const result = childProcess.spawnSync('sysctl', ['-n', 'hw.optional.avx2_0'], {
				encoding: 'utf8',
				timeout: 2000,
			})
			return result.status === 0 && result.stdout.trim() === '1'
		}
		if (platform === 'windows') {
			const command =
				'(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
			for (const executable of ['powershell.exe', 'pwsh.exe', 'pwsh', 'powershell']) {
				const result = childProcess.spawnSync(
					executable,
					['-NoProfile', '-NonInteractive', '-Command', command],
					{
						encoding: 'utf8',
						timeout: 3000,
						windowsHide: true,
					},
				)
				if (result.status !== 0) continue
				const output = result.stdout.trim().toLowerCase()
				if (output === 'true' || output === '1') return true
				if (output === 'false' || output === '0') return false
			}
		}
		return false
	} catch {
		return false
	}
}

function isMusl() {
	if (platform !== 'linux') return false
	if (fs.existsSync('/etc/alpine-release')) return true
	const result = childProcess.spawnSync('ldd', ['--version'], { encoding: 'utf8' })
	return `${result.stdout || ''}${result.stderr || ''}`.toLowerCase().includes('musl')
}

function candidates() {
	if (arch !== 'x64') return [base]
	const cpuVariants = supportsAvx2() ? ['', '-baseline'] : ['-baseline', '']
	if (platform === 'linux' && isMusl()) return cpuVariants.map((variant) => `${base}${variant}-musl`)
	return cpuVariants.map((variant) => `${base}${variant}`)
}

function copy(source) {
	fs.mkdirSync(path.dirname(target), { recursive: true })
	fs.rmSync(target, { force: true })
	try {
		fs.linkSync(source, target)
	} catch {
		fs.copyFileSync(source, target)
	}
	fs.chmodSync(target, 0o755)
	const verification = childProcess.spawnSync(target, ['--version'], { encoding: 'utf8', windowsHide: true })
	if (verification.status !== 0) throw new Error(`Installed binary failed verification: ${verification.stderr}`)
}

function recover(name) {
	const version = manifest.optionalDependencies?.[name]
	if (!version) return false
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-install-'))
	try {
		const result = childProcess.spawnSync(
			'npm',
			['install', '--ignore-scripts', '--no-save', '--loglevel=error', '--prefix', temp, `${name}@${version}`],
			{ stdio: 'inherit', windowsHide: true },
		)
		if (result.status !== 0) return false
		copy(path.join(temp, 'node_modules', ...name.split('/'), 'bin', sourceName))
		return true
	} finally {
		fs.rmSync(temp, { recursive: true, force: true })
	}
}

for (const name of candidates()) {
	try {
		copy(path.join(path.dirname(require.resolve(`${name}/package.json`)), 'bin', sourceName))
		process.exit(0)
	} catch {
		if (recover(name)) process.exit(0)
	}
}
throw new Error(`No compatible foldcode binary found for ${platform}-${arch}`)
