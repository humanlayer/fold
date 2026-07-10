/**
 * Bash tool tests: real processes in temp dirs. Covers output capture and exit-code semantics, the
 * timeout kill (including grandchildren via the process group), schema-typed stdout/stderr streaming
 * deltas, tail truncation with spill files, EPIPE-style pipelines, and input validation.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from '@effect/vitest'
import { SessionId, ToolCallId } from '@humanlayer/tart-core'
import { Duration, Effect, Fiber } from 'effect'

import { bashTool, decodeBashOutputDelta, makeOutputStore, toolOutputPathFor } from '../../src/index'
import { handlerOf, makeAmbientServices, messageOf, outputOf, runHandler, tempDir } from '../TestHelpers'

it.live('captures stdout and reports success on exit 0', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const result = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: 'echo hello tart' }))

		expect(outputOf(result)).toBe('hello tart\n')
	}),
)

it.live('interleaves stderr into the same output buffer', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const result = yield* runHandler(
			handlerOf(bashTool({ cwd: dir }))({ command: 'echo out && echo err 1>&2 && echo out2' }),
		)

		expect(outputOf(result)).toContain('out')
		expect(outputOf(result)).toContain('err')
		expect(outputOf(result)).toContain('out2')
	}),
)

it.live('runs in the provided workdir', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		writeFileSync(join(dir, 'marker.txt'), 'present')

		const result = yield* runHandler(handlerOf(bashTool())({ command: 'ls', workdir: dir }))

		expect(outputOf(result)).toContain('marker.txt')
	}),
)

it.live('non-zero exits are typed failures carrying output and the exit code', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const failure = yield* runHandler(
			handlerOf(bashTool({ cwd: dir }))({ command: 'echo some output && exit 3' }),
		).pipe(Effect.flip)

		expect(messageOf(failure)).toBe('some output\n\n\nCommand exited with code 3')
	}),
)

it.live('missing workdir fails fast with the pi message', () =>
	Effect.gen(function* () {
		const failure = yield* runHandler(
			handlerOf(bashTool())({ command: 'echo hi', workdir: '/definitely/not/here' }),
		).pipe(Effect.flip)

		expect(messageOf(failure)).toBe(
			'Working directory does not exist: /definitely/not/here\nCannot execute bash commands.',
		)
	}),
)

it.live('invalid timeouts are rejected before spawning', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const failure = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: 'echo hi', timeout: -1 })).pipe(
			Effect.flip,
		)

		expect(messageOf(failure)).toBe('Invalid timeout: must be a finite number of seconds')
	}),
)

it.live('timeout kills the whole process group, including grandchildren', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const grandchildMarker = join(dir, 'grandchild-survived.txt')

		// The command spawns a backgrounded grandchild that would write a marker after 2s. The 1s
		// timeout must kill the entire group, so the marker never appears.
		const failure = yield* runHandler(
			handlerOf(bashTool({ cwd: dir }))({
				command: `(sleep 2 && echo alive > ${grandchildMarker}) & echo started && sleep 10`,
				timeout: 1,
			}),
		).pipe(Effect.flip)

		expect(messageOf(failure)).toContain('started')
		expect(messageOf(failure)).toContain('<system-reminder>Command timed out after 1 seconds</system-reminder>')

		// Give any surviving grandchild time to prove itself, then assert it was killed.
		yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2500)))
		expect(existsSync(grandchildMarker)).toBe(false)
	}),
)

it.live('emits schema-typed stdout/stderr deltas while running', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const ambient = yield* makeAmbientServices()

		yield* handlerOf(bashTool({ cwd: dir }))({ command: 'echo to-stdout && echo to-stderr 1>&2' }).pipe(
			Effect.provide(ambient.layer),
		)

		const deltas = (yield* ambient.emitted).map(decodeBashOutputDelta)
		expect(deltas.every((delta) => delta !== null)).toBe(true)

		const stdoutText = deltas
			.filter((delta) => delta?.stream === 'stdout')
			.map((delta) => delta?.text)
			.join('')
		const stderrText = deltas
			.filter((delta) => delta?.stream === 'stderr')
			.map((delta) => delta?.text)
			.join('')
		expect(stdoutText).toBe('to-stdout\n')
		expect(stderrText).toBe('to-stderr\n')
	}),
)

it.live('tail-truncates long output and spills the full output to a file', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const result = yield* runHandler(handlerOf(bashTool({ cwd: dir, spillDir: dir }))({ command: 'seq 1 3000' }))
		const output = outputOf(result)

		// Tail direction: the last lines survive, the head is cut. pi's line accounting: the trailing
		// newline terminates line 3000 rather than opening line 3001.
		expect(output).toContain('\n3000\n')
		expect(output.startsWith('1001\n')).toBe(true)
		expect(output).toContain('[Showing lines 1001-3000 of 3000. Full output: ')

		const spillPath = output.match(/Full output: (\S+)\]/)?.[1]
		if (spillPath === undefined) throw new Error('expected a spill path in the notice')
		expect(existsSync(spillPath)).toBe(true)
		const spilled = readFileSync(spillPath, 'utf-8')
		expect(spilled.startsWith('1\n2\n3\n')).toBe(true)
		expect(spilled.endsWith('2999\n3000\n')).toBe(true)
	}),
)

it.live('uses OutputStore for deterministic bash spill paths when provided', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const sessionId = SessionId.make('sess_eeeeeeeeeeeeeeeeeeeeeeee')
		const toolCallId = ToolCallId.make('tool_call_aaaaaaaaaaaaaaaaaaaaaaaa')
		const outputStore = makeOutputStore({ sessionId, tartHome: dir })
		const ambient = yield* makeAmbientServices()

		const result = yield* handlerOf(bashTool({ cwd: dir, outputStore }))({ command: 'seq 1 3000' }).pipe(
			Effect.provide(ambient.layer),
		)
		const expectedPath = toolOutputPathFor({ sessionId, toolCallId, tartHome: dir })

		expect(outputOf(result)).toContain(`Full output: ${expectedPath}`)
		expect(readFileSync(expectedPath, 'utf-8')).toContain('1\n2\n3\n')
		expect(readFileSync(expectedPath, 'utf-8')).toContain('2999\n3000\n')
	}),
)

it.live('byte-limit truncation reports the size-limited notice with the spill path', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		// ~100KB of output in few lines: byte limit binds before the line limit.
		const result = yield* runHandler(
			handlerOf(bashTool({ cwd: dir, spillDir: dir }))({
				command: `for i in $(seq 1 100); do printf 'x%.0s' $(seq 1 1024); printf '\\n'; done`,
			}),
		)
		const output = outputOf(result)

		expect(output).toContain('(50.0KB limit). Full output: ')
	}),
)

it.live('EPIPE-style pipelines complete normally', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		// `head -1` closes the pipe early; `seq` receives EPIPE/SIGPIPE. The pipeline still exits 0.
		const result = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: 'seq 1 100000 | head -1' }))

		expect(outputOf(result)).toBe('1\n')
	}),
)

it.live('reports (no output) for silent commands', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const result = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: 'true' }))

		expect(outputOf(result)).toBe('(no output)')
	}),
)

it.live('escalates to SIGKILL for commands that trap SIGTERM', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const started = Date.now()

		// The command ignores SIGTERM; only the 200ms SIGKILL escalation can end it.
		const failure = yield* runHandler(
			handlerOf(bashTool({ cwd: dir }))({ command: "trap '' TERM; echo trapped; sleep 30", timeout: 1 }),
		).pipe(Effect.flip)

		expect(messageOf(failure)).toContain('trapped')
		expect(messageOf(failure)).toContain('<system-reminder>Command timed out after 1 seconds</system-reminder>')
		// 1s timeout + 200ms grace + slack: far below the 30s sleep.
		expect(Date.now() - started).toBeLessThan(10_000)
	}),
)

it.live('a signal-killed command is a success, not an error (pi semantics)', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const result = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: 'echo before && kill -KILL $$' }))

		expect(outputOf(result)).toBe('before\n')
	}),
)

it.live('an empty-output timeout reports only the status (no "(no output)" prefix)', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const failure = yield* runHandler(handlerOf(bashTool({ cwd: dir }))({ command: 'sleep 5', timeout: 1 })).pipe(
			Effect.flip,
		)

		expect(messageOf(failure)).toBe('<system-reminder>Command timed out after 1 seconds</system-reminder>')
	}),
)

it.live('streams output to the spill file as it is written; interruption notes the path (ruling 5)', () =>
	Effect.gen(function* () {
		const dir = yield* tempDir
		const ambient = yield* makeAmbientServices()
		const tool = bashTool({ cwd: dir, spillDir: dir })

		const commandFiber = yield* Effect.forkChild(
			handlerOf(tool)({ command: 'echo early-output; sleep 30' }).pipe(
				Effect.provide(ambient.layer),
				Effect.exit,
			),
		)

		// The streamed chunk lands on disk long before the command could finish (stream-as-written).
		const spill = yield* Effect.gen(function* () {
			while (true) {
				const file = readdirSync(dir).find((name) => name.startsWith('tart-bash-'))
				if (file !== undefined) {
					const path = join(dir, file)
					const content = readFileSync(path, 'utf8')
					if (content.includes('early-output')) return { path, content }
				}
				yield* Effect.sleep(Duration.millis(25))
			}
		})

		yield* Fiber.interrupt(commandFiber)

		expect(spill.content).toContain('early-output')
		const note = yield* ambient.interruptNote
		expect(note).toContain(spill.path)
		expect(note).toContain('partial output')
	}).pipe(Effect.scoped),
)
