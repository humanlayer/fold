import { useTerminalDimensions } from '@opentui/react'

import type { FxToggles } from '../hud/postfx'
import { useTheme } from '../theme/index'
import { KeyHint } from './atoms'

/** Below this the FX block drops its names and shows just `B:ON S:ON …`. */
const VERBOSE_WIDTH = 120

/**
 * `B GLOW:ON` — key, what it does, and whether it is running. The name is what
 * makes the key discoverable; without it the row is a line of initials and the
 * only way to learn that `r` drives the CRT bar is to read the source.
 *
 * A pass the active theme never declares renders wholly faint as `--`. Printing
 * `ON` for an effect that cannot run would make the readout lie.
 */
function Toggle({ label, name, on, available }: { label: string; name: string; on: boolean; available: boolean }) {
	const { color } = useTheme()
	const { width } = useTerminalDimensions()
	const verbose = width >= VERBOSE_WIDTH

	const key = verbose ? `${label} ${name}` : label

	if (!available) {
		return (
			<text wrapMode="none" fg={color.textFaint}>
				{`${key}:--`}
			</text>
		)
	}

	return (
		<text wrapMode="none">
			<span fg={color.coreBright}>{label}</span>
			{verbose ? <span fg={color.textFaint}>{` ${name}`}</span> : null}
			<span fg={color.textFaint}>{':'}</span>
			<span fg={on ? color.grid : color.textFaint}>{on ? 'ON' : 'OFF'}</span>
		</text>
	)
}

export function Footer({ toggles }: { toggles: FxToggles }) {
	const theme = useTheme()
	const { color, chrome, fx } = theme

	return (
		<box
			flexDirection="row"
			height={2}
			paddingX={1}
			gap={2}
			alignItems="center"
			border={['top']}
			borderStyle={chrome.frameStyle}
			borderColor={chrome.border}
		>
			<KeyHint keyName="↑↓/jk" label="SELECT" />
			<KeyHint keyName="TAB" label="PULLS/ISSUES" />
			<KeyHint keyName="T" label="THEME" />
			<KeyHint keyName="Q" label="QUIT" />

			<box flexGrow={1} />

			<text fg={color.textFaint} wrapMode="none">
				{'FX//'}
			</text>
			<Toggle label="B" name="GLOW" on={toggles.glow} available={fx.glow !== undefined} />
			<Toggle label="S" name="SCAN" on={toggles.scanlines} available={fx.scanlines !== undefined} />
			<Toggle label="G" name="GLITCH" on={toggles.glitch} available={fx.glitch !== undefined} />
			<Toggle label="V" name="VIGNETTE" on={toggles.vignette} available={fx.vignette !== undefined} />
			<Toggle label="R" name="CRT-BAR" on={toggles.rollingBar} available={fx.crtBar !== undefined} />
		</box>
	)
}
