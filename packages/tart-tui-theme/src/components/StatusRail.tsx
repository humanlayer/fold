import { displayState } from '../github/types.ts'
import type { GhItem } from '../github/types.ts'
import { useTheme } from '../theme/index.ts'
import { useStateStyle } from './atoms.tsx'
import { Telemetry } from './Telemetry.tsx'

/** Navigational coordinates read teal, per the brief. Derived from the selection. */
function Coords({ item }: { item: GhItem | undefined }) {
	const theme = useTheme()
	const { color } = theme
	const style = useStateStyle(item ? displayState(item) : 'open')

	const lat = item ? (item.number * 37) % 9000 : 0
	const lon = item ? (item.number * 53) % 18_000 : 0

	return (
		<box flexDirection="column" flexShrink={0} paddingX={1}>
			<text wrapMode="none">
				<span fg={color.textFaint}>{'LAT '}</span>
				<span fg={color.grid}>{(lat / 100).toFixed(2).padStart(6)}</span>
				<span fg={color.textFaint}>{'  LON '}</span>
				<span fg={color.grid}>{(lon / 100).toFixed(2).padStart(6)}</span>
			</text>
			<text wrapMode="none">
				<span fg={color.textFaint}>{'LOCK '}</span>
				<span fg={item ? color.alert : color.textFaint}>{item ? `#${item.number}` : '----'}</span>
				<span fg={color.textFaint}>{'  ST '}</span>
				<span fg={item ? style.color : color.textFaint}>{item ? style.label : '----'}</span>
			</text>
		</box>
	)
}

export function StatusRail({ width, item }: { width: number; item: GhItem | undefined }) {
	const theme = useTheme()
	const { color, chrome } = theme

	return (
		<box width={width} flexShrink={0} flexDirection="column">
			<box
				flexGrow={3}
				minHeight={16}
				flexDirection="column"
				border
				borderStyle={chrome.panelStyle}
				borderColor={chrome.border}
				title=" OPTIC "
				titleColor={chrome.title}
				backgroundColor={color.panel}
			>
				{/*
				 * "secondary structural grids" in electric teal (brief A) / "dotted grids
				 * ... as ... background textures to establish 3D space" (brief B). A sparse,
				 * STATIC dotted lattice — nodes only, no connecting rules — so the reticle
				 * reads first and this is a distant structural texture the rings sit over,
				 * never a competing set of ruled lines. Centred on the box, so it frames the
				 * crosshair symmetrically. Absolutely positioned to fill the panel; the
				 * reticle draws over it.
				 */}
				<grid
					position="absolute"
					left={0}
					top={0}
					right={0}
					bottom={0}
					mode="nodes"
					color={color.gridDim}
					spacingX={6}
					spacingY={3}
				/>
				<reticle spec={theme.reticle} flexGrow={1} />
				<Coords item={item} />
			</box>

			<box
				height={6}
				flexShrink={0}
				paddingX={1}
				paddingY={0}
				border
				borderStyle={chrome.panelStyle}
				borderColor={chrome.border}
				title=" TELEMETRY "
				titleColor={chrome.title}
				backgroundColor={color.panel}
			>
				<Telemetry />
			</box>

			<box
				flexGrow={1}
				minHeight={5}
				border
				borderStyle={chrome.panelStyle}
				borderColor={chrome.border}
				title=" INJECT "
				titleColor={chrome.title}
				backgroundColor={color.panel}
			>
				{/*
				 * The most literal read of the grid language in either brief: "a
				 * cylindrical, spinning column of amber text intersected by a flat,
				 * horizontal plane of teal gridlines" (brief A). The data stream IS the
				 * spinning column of text; this faint dotted plane is what it is
				 * intersected by — faint dotted rules the falling code crosses,
				 * establishing the floor the stream rains onto (brief B: "floor planes").
				 * Tight `spacingX` makes each lattice row read as a horizontal dotted rule
				 * (a "plane of gridlines"); nodes only and static, so it stays a background
				 * plane the foreground stream is pushed in front of, never noise.
				 */}
				<grid
					position="absolute"
					left={0}
					top={0}
					right={0}
					bottom={0}
					mode="nodes"
					color={color.gridDim}
					spacingX={2}
					spacingY={2}
				/>
				<dataStream flexGrow={1} chars={theme.streamChars} head={color.inject} trail={color.injectDim} />
			</box>
		</box>
	)
}
