import { spawn } from 'node:child_process'

import { Effect } from 'effect'

const browserOpenCommand = (url: string): { readonly command: string; readonly args: ReadonlyArray<string> } => {
	switch (process.platform) {
		case 'darwin':
			return { command: 'open', args: [url] }
		case 'win32':
			return { command: 'cmd', args: ['/c', 'start', '', url] }
		default:
			return { command: 'xdg-open', args: [url] }
	}
}

export const openUrlInBrowser = (url: string): Effect.Effect<boolean> =>
	Effect.try({
		try: () => {
			const { command, args } = browserOpenCommand(url)
			const child = spawn(command, args, { stdio: 'ignore', detached: true })
			child.on('error', () => undefined)
			child.unref()
			return true
		},
		catch: () => false,
	}).pipe(Effect.catch((opened) => Effect.succeed(opened)))
