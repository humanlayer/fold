// Relative imports use explicit .ts extensions: when Vite externalizes this
// workspace package, Node imports the TypeScript source natively under strict
// ESM resolution, where extensionless relative imports would fail at load time.
export { base } from './base.ts'
