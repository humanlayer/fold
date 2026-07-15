/**
 * This file is the pure parser for the interactive readline loop's input: one line in, one tagged
 * command out. Plain text is a chat message (the loop decides send-vs-steer from run state); slash
 * commands cover help, graceful stop, targeted steer/send by agent id, and exit. Agent targets are
 * validated with the reference guard (`isAgentIdRef`): a full id or the short `agent_ab12cd34` form the
 * renderer displays, so what users see is what they can type - typos come back as instructive
 * `invalid` values instead of runtime failures, and the session resolves the reference to a full id.
 */
import { isAgentIdRef } from '@humanlayer/fold-core'

/** One parsed line of interactive input. Steer/send targets are full ids or unique short references. */
export type InteractiveCommand =
	| { readonly _tag: 'message'; readonly text: string }
	| { readonly _tag: 'exit' }
	| { readonly _tag: 'help' }
	| { readonly _tag: 'compact' }
	| { readonly _tag: 'stop'; readonly reason: string | undefined }
	| { readonly _tag: 'steer'; readonly agentId: string; readonly text: string }
	| { readonly _tag: 'send'; readonly agentId: string; readonly text: string }
	| { readonly _tag: 'invalid'; readonly message: string }

const exitCommands = new Set(['exit', '/exit', 'quit', '/quit'])

const steerUsage = 'usage: /steer <agent_id> <text> (agent ids appear on subagent start lines)'
const sendUsage = 'usage: /send <agent_id> <text> (agent ids appear on subagent start lines)'

/** Split a trimmed string at its first whitespace run; `rest` comes back left-trimmed. */
const splitFirstWord = (input: string): { readonly word: string; readonly rest: string } => {
	const match = /\s/.exec(input)
	if (match === null) return { word: input, rest: '' }

	return { word: input.slice(0, match.index), rest: input.slice(match.index + 1).trim() }
}

const parseTargeted = (tag: 'steer' | 'send', input: string, usage: string): InteractiveCommand => {
	const { word: rawId, rest: text } = splitFirstWord(input)
	if (rawId.length === 0) return { _tag: 'invalid', message: usage }
	if (!isAgentIdRef(rawId)) return { _tag: 'invalid', message: `"${rawId}" is not an agent id (agent_...); ${usage}` }
	if (text.length === 0) return { _tag: 'invalid', message: usage }

	return tag === 'steer' ? { _tag: 'steer', agentId: rawId, text } : { _tag: 'send', agentId: rawId, text }
}

/**
 * Parse one line of interactive input. Total: every line maps to a command, unknown or malformed
 * slash commands map to `invalid` with usage guidance, and anything else is a `message` (possibly
 * empty - the loop skips blank messages).
 */
export const parseInteractiveInput = (line: string): InteractiveCommand => {
	const trimmed = line.trim()
	if (exitCommands.has(trimmed)) return { _tag: 'exit' }
	if (!trimmed.startsWith('/')) return { _tag: 'message', text: trimmed }

	const { word, rest } = splitFirstWord(trimmed)
	switch (word) {
		case '/help':
			return rest.length === 0 ? { _tag: 'help' } : { _tag: 'invalid', message: '/help takes no arguments' }
		case '/compact':
			return rest.length === 0 ? { _tag: 'compact' } : { _tag: 'invalid', message: '/compact takes no arguments' }
		case '/stop':
			return { _tag: 'stop', reason: rest.length === 0 ? undefined : rest }
		case '/steer':
			return parseTargeted('steer', rest, steerUsage)
		case '/send':
			return parseTargeted('send', rest, sendUsage)
		case '/exit':
		case '/quit':
			return { _tag: 'invalid', message: `${word} takes no arguments` }
		default:
			return { _tag: 'invalid', message: `unknown command "${word}"; type /help for commands` }
	}
}
