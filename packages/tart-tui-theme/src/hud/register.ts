import { extend } from '@opentui/react'

import { DataStreamRenderable } from './DataStreamRenderable.ts'
import { GridRenderable } from './GridRenderable.ts'
import { ReticleRenderable } from './ReticleRenderable.ts'

/**
 * Register the custom renderables as JSX intrinsic elements.
 *
 * `extend` populates the runtime catalogue; the module augmentation makes
 * `<reticle>`, `<dataStream>`, and `<grid>` type-check in JSX.
 */
declare module '@opentui/react' {
	interface OpenTUIComponents {
		reticle: typeof ReticleRenderable
		dataStream: typeof DataStreamRenderable
		grid: typeof GridRenderable
	}
}

extend({ reticle: ReticleRenderable, dataStream: DataStreamRenderable, grid: GridRenderable })

export { DataStreamRenderable, GridRenderable, ReticleRenderable }
