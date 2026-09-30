import path from 'node:path'

import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type ImportDeclarationNode = Parameters<NonNullable<VisitorObject['ImportDeclaration']>>[0]
type ExportAllDeclarationNode = Parameters<NonNullable<VisitorObject['ExportAllDeclaration']>>[0]
type ExportNamedDeclarationNode = Parameters<NonNullable<VisitorObject['ExportNamedDeclaration']>>[0]
type ModuleDeclarationNode = ExportAllDeclarationNode | ExportNamedDeclarationNode | ImportDeclarationNode

interface Options {
	readonly allowedImports?: ReadonlyArray<string>
	readonly contractRootMarker?: string
}

const _contractRoot = ({ filename, rootMarker }: { filename: string; rootMarker: string }) => {
	const markerIndex = filename.indexOf(rootMarker)
	return markerIndex === -1 ? undefined : filename.slice(0, markerIndex + rootMarker.length).replace(/\/$/, '')
}

const _isLocalImport = ({
	contractRoot,
	filename,
	source,
}: {
	contractRoot: string
	filename: string
	source: string
}) => {
	if (!source.startsWith('.')) {
		return false
	}

	const resolved = path.posix.resolve(path.posix.dirname(filename), source)

	return resolved === contractRoot || resolved.startsWith(`${contractRoot}/`)
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Keep the public contract area independent from backend and persistence modules.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					allowedImports: {
						type: 'array',
						items: { type: 'string' },
					},
					contractRootMarker: { type: 'string' },
				},
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const options = (context.options[0] ?? {}) as Options
		const rootMarker = options.contractRootMarker ?? '/src/contracts/'
		const allowedImports = options.allowedImports ?? ['@scope/contracts', 'effect']
		const contractRoot = _contractRoot({ filename, rootMarker })

		if (contractRoot === undefined) {
			return {}
		}
		const isAllowedImport = ({ source }: { source: string }) =>
			allowedImports.some((allowed) => source === allowed || source.startsWith(`${allowed}/`))

		const checkSource = ({ node, source }: { node: ModuleDeclarationNode; source: unknown }) => {
			if (
				typeof source !== 'string' ||
				isAllowedImport({ source }) ||
				_isLocalImport({
					contractRoot,
					filename,
					source,
				})
			) {
				return
			}

			context.report({
				node,
				message:
					'The public contract area may import only local modules and explicitly allowed dependencies. Keep backend and persistence models in their owning application.',
			})
		}

		return {
			ExportAllDeclaration(node) {
				checkSource({ node, source: node.source.value })
			},
			ExportNamedDeclaration(node) {
				checkSource({ node, source: node.source?.value })
			},
			ImportDeclaration(node) {
				checkSource({ node, source: node.source.value })
			},
		}
	},
}

export default rule
