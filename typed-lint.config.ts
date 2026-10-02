import { defineConfig } from './tools/typed/src/config'

export default defineConfig({
	projects: ['packages/*/tsconfig.json'],
	projectExcludes: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**'],
	sourceExcludes: [
		'**/*.d.ts',
		'**/node_modules/**',
		'**/dist/**',
		'**/build/**',
		'**/coverage/**',
		'tools/**',
		// Vendored upstream source keeps its own baseline, matching `.eslintignore`.
		'packages/effect-ai-openai/src/**',
		'packages/effect-ai-anthropic/src/**',
		'packages/effect-ai-openai-compat/src/**',
		// TUI code permits exploratory implementation patterns, matching `.oxlintrc.jsonc`.
		'packages/fold-tui-theme/**',
		'packages/fold-cli/src/tui/**',
		'packages/fold-cli/test/tui/**',
		'packages/fold-cli/test/Tui*.vi.test.ts',
		'packages/fold-cli/test/fixtures/Tui*.tsx',
	],
	rules: {
		'no-svg-files': ['error', { include: ['**/*.svg'], exclude: ['**/node_modules/**'] }],
		'no-xstate-derived-boolean-context': 'error',
		'prefer-effect-array-match': 'error',
		'prefer-typed-schema-apis': 'error',
	},
})
