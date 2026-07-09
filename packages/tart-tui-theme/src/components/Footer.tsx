import type { FxToggles } from '../hud/postfx'
import { useTheme } from '../theme/index'
import { KeyHint } from './atoms'

/**
 * `B:ON` when the theme declares the pass and the toggle permits it, `B:OFF` when
 * the toggle is off, and `B:--` when this theme has no such effect at all
 * (AUGMENTED has no vignette and no rolling bar). Printing `ON` for a pass that
 * cannot run would make the readout lie.
 */
function Toggle({ label, on, available }: { label: string; on: boolean; available: boolean }) {
	const { color } = useTheme()

	if (!available) {
		return (
			<text wrapMode="none" fg={color.textFaint}>
				{`${label}:--`}
			</text>
		)
	}

	return (
		<text wrapMode="none">
			<span fg={color.textFaint}>{`${label}:`}</span>
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
			<Toggle label="B" on={toggles.glow} available={fx.glow !== undefined} />
			<Toggle label="S" on={toggles.scanlines} available={fx.scanlines !== undefined} />
			<Toggle label="G" on={toggles.glitch} available={fx.glitch !== undefined} />
			<Toggle label="V" on={toggles.vignette} available={fx.vignette !== undefined} />
			<Toggle label="R" on={toggles.rollingBar} available={fx.crtBar !== undefined} />
		</box>
	)
}
