#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { loadConfig } from './config.js'
import { formatDiagnostic, runTypedLint } from './engine.js'

type CliOptions = {
	command: 'check' | 'fix'
	configPath?: string
	format: 'json' | 'stylish'
	rootDir: string
}

const usage = `Usage: typed-lint [check|fix] [options]

Options:
  --config <path>     Load a configuration file
  --format <style>    stylish (default) or json
  --root <directory>  Workspace or repository root (default: current directory)
  -h, --help          Show this help

The current bundled rules are diagnostic-only. "fix" exits with status 2 rather
than pretending to modify files. Configure projects, exclusions, severities, and
rule options in typed-lint.config.mjs or typed-lint.config.json.`

export const parseArgs = (args: readonly string[]): CliOptions | 'help' => {
	let command: CliOptions['command'] = 'check'
	let configPath: string | undefined
	let format: CliOptions['format'] = 'stylish'
	let rootDir = process.cwd()
	let index = 0

	if (args[0] === 'check' || args[0] === 'fix') {
		command = args[0]
		index += 1
	}

	while (index < args.length) {
		const argument = args[index]

		if (argument === '--help' || argument === '-h') {
			return 'help'
		}

		const value = args[index + 1]

		if (argument === '--config' || argument === '--root' || argument === '--format') {
			if (value === undefined) {
				throw new Error(`Missing value for ${argument}.`)
			}

			if (argument === '--config') {
				configPath = value
			} else if (argument === '--root') {
				rootDir = value
			} else if (value === 'json' || value === 'stylish') {
				format = value
			} else {
				throw new Error('--format must be "json" or "stylish".')
			}

			index += 2
			continue
		}

		throw new Error(`Unknown argument "${argument}".`)
	}

	return { command, configPath, format, rootDir }
}

export const main = async (args = process.argv.slice(2)): Promise<number> => {
	try {
		const options = parseArgs(args)

		if (options === 'help') {
			process.stdout.write(`${usage}\n`)
			return 0
		}

		if (options.command === 'fix') {
			process.stderr.write(
				'typed-lint: no bundled rule currently provides an automatic fix; no files were changed.\n',
			)
			return 2
		}

		const config = await loadConfig({
			configPath: options.configPath,
			rootDir: options.rootDir,
		})
		const result = runTypedLint({ config })

		if (options.format === 'json') {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
		} else {
			for (const diagnostic of result.diagnostics) {
				process.stderr.write(`${formatDiagnostic(diagnostic)}\n`)
			}

			process.stdout.write(
				`typed-lint: ${result.errorCount} error(s), ${result.warningCount} warning(s), ${result.projectPaths.length} project(s).\n`,
			)
		}

		return result.errorCount > 0 ? 1 : 0
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		process.stderr.write(`typed-lint: ${message}\n`)
		return 2
	}
}

const invokedFile = process.argv[1] === undefined ? undefined : fs.realpathSync.native(process.argv[1])

if (invokedFile !== undefined && invokedFile === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
	process.exitCode = await main()
}
