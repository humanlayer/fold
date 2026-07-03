import { defineConfig } from 'vitest/config'

/**
 * Shared base Vitest config for every package in the monorepo.
 *
 * - `environment: "node"` — tests run on the Node runtime
 * - `pool: "forks"` — pinned explicitly so it can't drift
 * - 15s default test timeout — override per package as needed
 *
 * Usage in a package's `vitest.config.ts`:
 * ```ts
 * import { base } from "@humanlayer/tart-vitest-config"
 * import { defineConfig, mergeConfig } from "vitest/config"
 *
 * export default mergeConfig(base, defineConfig({ ... }))
 * ```
 */
export const base = defineConfig({
	test: {
		environment: 'node',
		pool: 'forks',
		testTimeout: 15_000,
	},
})
