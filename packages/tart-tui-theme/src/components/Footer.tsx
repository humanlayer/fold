import type { FxToggles } from '../hud/postfx.ts'
import { useTheme } from '../theme/index.ts'
import { KeyHint } from './atoms.tsx'

function Toggle({ label, on }: { label: string; on: boolean }) {
	const theme = useTheme()
	return (
		<text wrapMode="none">
			<span fg={theme.color.textFaint}>{`${label}:`}</span>
			<span fg={on ? theme.color.grid : theme.color.textFaint}>{on ? 'ON' : 'OFF'}</span>
		</text>
	)
}

export function Footer({ toggles }: { toggles: FxToggles }) {
	const theme = useTheme()
	const { color, chrome } = theme

	return (
		<box
			flexDirection="row"
			height={2}
			paddingX={1}
			gap={3}
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
			<Toggle label="B" on={toggles.bloom} />
			<Toggle label="S" on={toggles.scanlines} />
			<Toggle label="G" on={toggles.glitch} />
			<Toggle label="C" on={toggles.crt} />
		</box>
	)
}
