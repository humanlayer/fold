import { defineRule, eslintCompatPlugin } from '@oxlint/plugins'

const relativeSourceExtension = /^\.{1,2}\/.*\.(?:[cm]?[jt]sx?)(?:[?#].*)?$/u

export default eslintCompatPlugin({
	meta: { name: 'import-extensions' },
	rules: {
		'no-relative-source-extensions': defineRule({
			meta: {
				type: 'problem',
				schema: [],
				messages: {
					extension: 'Use an extensionless relative import instead of a TypeScript or JavaScript extension.',
				},
			},
			createOnce(context) {
				function check(node) {
					if (!node) return
					const value =
						node.type === 'TemplateLiteral'
							? node.quasis.map((quasi) => quasi.value.cooked ?? '').join('')
							: node.value
					if (value !== null && value !== undefined && relativeSourceExtension.test(value)) {
						context.report({ node, messageId: 'extension' })
					}
				}
				return {
					ImportDeclaration(node) {
						check(node.source)
					},
					ExportNamedDeclaration(node) {
						check(node.source)
					},
					ExportAllDeclaration(node) {
						check(node.source)
					},
					ImportExpression(node) {
						check(node.source)
					},
					TSImportType(node) {
						check(node.source)
					},
					TSExternalModuleReference(node) {
						check(node.expression)
					},
				}
			},
		}),
	},
})
