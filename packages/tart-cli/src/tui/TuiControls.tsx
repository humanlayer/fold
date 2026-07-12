/** @jsxImportSource @opentui/solid */
import { ALL_FX_ON, type FxToggles } from '@humanlayer/tart-tui-theme/postfx'
import { THEMES, THEME_ORDER, type ThemeId } from '@humanlayer/tart-tui-theme/themes'
import { createSignal, type Accessor } from 'solid-js'

import type { TuiCommand } from './CommandPalette'
import { theme as tactical } from './ThemeState'

export type FxControls = {
	readonly toggles: Accessor<FxToggles>
	readonly setToggles: (update: (current: FxToggles) => FxToggles) => void
}

export const createFxControls = (
	toggles?: Accessor<FxToggles>,
	setToggles?: (update: (current: FxToggles) => FxToggles) => void,
): FxControls => {
	const [fallback, setFallback] = createSignal<FxToggles>({ ...ALL_FX_ON, vignette: 'light' })
	return { toggles: () => toggles?.() ?? fallback(), setToggles: setToggles ?? setFallback }
}

export const themeCommands = (onSelect?: (theme: ThemeId) => void): ReadonlyArray<TuiCommand> =>
	THEME_ORDER.map((id) => ({
		id: `theme.${id}`,
		title: THEMES[id].name,
		category: 'VIEW',
		run: () => onSelect?.(id),
	}))

export const fxCommands = ({
	toggles,
	setToggles,
}: FxControls): readonly [TuiCommand, TuiCommand, TuiCommand, TuiCommand, TuiCommand] => [
	{
		id: 'glow',
		title: `Turn glow ${toggles().glow ? 'off' : 'on'}`,
		category: 'VIEW',
		shortcut: 'B',
		run: () => setToggles((v) => ({ ...v, glow: !v.glow })),
	},
	{
		id: 'scan',
		title: `Turn scanlines ${toggles().scanlines ? 'off' : 'on'}`,
		category: 'VIEW',
		shortcut: 'S',
		run: () => setToggles((v) => ({ ...v, scanlines: !v.scanlines })),
	},
	{
		id: 'glitch',
		title: `Turn glitch ${toggles().glitch ? 'off' : 'on'}`,
		category: 'VIEW',
		shortcut: 'G',
		run: () => setToggles((v) => ({ ...v, glitch: !v.glitch })),
	},
	{
		id: 'vignette',
		title: 'Vignette…',
		category: 'VIEW',
		shortcut: 'V',
		children: (['off', 'light', 'heavy'] as const).map((mode) => ({
			id: `vignette.${mode}`,
			title: mode.toUpperCase(),
			category: 'VIEW',
			run: () => setToggles((v) => ({ ...v, vignette: mode })),
		})),
	},
	{
		id: 'bar',
		title: `Turn rolling CRT bar ${toggles().rollingBar ? 'off' : 'on'}`,
		category: 'VIEW',
		shortcut: 'R',
		run: () => setToggles((v) => ({ ...v, rollingBar: !v.rollingBar })),
	},
]

export const KeyHint = (props: { readonly keyName: string; readonly label: string }) => (
	<text wrapMode="none">
		<span style={{ fg: tactical.color.coreBright }}>{props.keyName}</span>
		<span style={{ fg: tactical.color.textDim }}>{` ${props.label}`}</span>
	</text>
)

const Toggle = (props: {
	readonly label: string
	readonly name: string
	readonly enabled: boolean
	readonly status?: string
	readonly verbose: boolean
}) => (
	<text wrapMode="none">
		<span style={{ fg: tactical.color.coreBright }}>{props.label}</span>
		{props.verbose ? <span style={{ fg: tactical.color.textDim }}>{` ${props.name}`}</span> : null}
		<span style={{ fg: tactical.color.textDim }}>:</span>
		<span style={{ fg: props.enabled ? tactical.color.grid : tactical.color.textDim }}>
			{props.status ?? (props.enabled ? 'ON' : 'OFF')}
		</span>
	</text>
)

export const FxFooter = (props: { readonly toggles: FxToggles; readonly verbose: boolean }) => (
	<>
		<text fg={tactical.color.textDim} wrapMode="none">
			FX//
		</text>
		<Toggle label="B" name="GLOW" enabled={props.toggles.glow} verbose={props.verbose} />
		<Toggle label="S" name="SCAN" enabled={props.toggles.scanlines} verbose={props.verbose} />
		<Toggle label="G" name="GLITCH" enabled={props.toggles.glitch} verbose={props.verbose} />
		<Toggle
			label="V"
			name="VIGNETTE"
			enabled={props.toggles.vignette !== 'off'}
			status={props.toggles.vignette.toUpperCase()}
			verbose={props.verbose}
		/>
		<Toggle label="R" name="CRT-BAR" enabled={props.toggles.rollingBar} verbose={props.verbose} />
	</>
)
