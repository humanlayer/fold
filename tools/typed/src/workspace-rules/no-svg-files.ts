import path from 'node:path'

import fg from 'fast-glob'

import type { WorkspaceRule } from '../rule.js'

const stringArrayOption = ({
	fallback,
	name,
	options,
}: {
	fallback: readonly string[]
	name: string
	options: Readonly<Record<string, unknown>>
}) => {
	const value = options[name]

	if (value === undefined) {
		return fallback
	}

	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
		throw new Error(`no-svg-files option "${name}" must be an array of strings.`)
	}

	return value
}

const noSvgFiles: WorkspaceRule = {
	name: 'no-svg-files',
	check: ({ options, report, rootDir }) => {
		const include = stringArrayOption({
			fallback: ['**/*.svg'],
			name: 'include',
			options,
		})
		const exclude = stringArrayOption({
			fallback: [
				'**/.git/**',
				'**/.next/**',
				'**/build/**',
				'**/coverage/**',
				'**/dist/**',
				'**/node_modules/**',
			],
			name: 'exclude',
			options,
		})

		for (const fileName of fg.sync([...include], {
			absolute: true,
			cwd: rootDir,
			dot: true,
			followSymbolicLinks: false,
			ignore: [...exclude],
			onlyFiles: true,
			unique: true,
		})) {
			report({
				column: 1,
				fileName: path.relative(rootDir, fileName),
				line: 1,
				message:
					'Inline first-party SVG markup in a component, or explicitly exclude generated and third-party assets.',
			})
		}
	},
}

export default noSvgFiles
