/** @jsxImportSource @opentui/solid */
import type { ThemeColors } from '@humanlayer/fold-tui-theme/theme-types'

/** Compact wordmark with subtle per-letter contrast from the active theme. */
export const FoldTitle = (props: { readonly color: ThemeColors }) => (
	<box flexDirection="row">
		<ascii_font text="F" font="tiny" color={props.color.core} />
		<ascii_font text="O" font="tiny" color={props.color.coreBright} />
		<ascii_font text="L" font="tiny" color={props.color.core} />
		<ascii_font text="D" font="tiny" color={props.color.coreDim} />
	</box>
)
