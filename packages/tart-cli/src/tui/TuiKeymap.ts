import type { CliRenderer } from '@opentui/core'
/** OpenTUI and managed editor layers legitimately share this internal event spine. */
export const prepareTuiKeyboard = (renderer: CliRenderer): void => {
	renderer._internalKeyInput.setMaxListeners(64)
}
