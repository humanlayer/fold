import { expect, it } from 'vitest'

import { TUI_CONTEXT_TITLE, TUI_FX_KEYS, TUI_LIVE_BADGE } from '../src/tui/TuiChrome'

it('exposes a TACTICAL live context shell with all five FX', () => {
	expect(TUI_CONTEXT_TITLE).toBe(' CONTEXT ')
	expect(TUI_LIVE_BADGE).toBe('LIVE')
	expect(TUI_FX_KEYS).toEqual(['B', 'S', 'G', 'V', 'R'])
})
