/**
 * The bash tool against a fake shell that records each command and answers with a scripted output.
 */
import { it } from '@effect/vitest'
import { Effect, FileSystem, Ref } from 'effect'
import { expect } from 'vitest'

import { bashTool } from '../src/BashTool'
import type { CommandInput, CommandOutput } from '../src/computer/Contract'
import { ShellError } from '../src/Workspace'
import { callTool } from './ToolCalls'

const output = (fields: Partial<CommandOutput>): CommandOutput => ({
	status: 'completed',
	exitCode: 0,
	stdout: '',
	stderr: '',
	...fields,
})

/** A bash tool whose shell answers every command with `answer`, recording the inputs. */
const fakeBash = (answer: Effect.Effect<CommandOutput, ShellError>) =>
	Effect.gen(function* () {
		const inputs = yield* Ref.make<ReadonlyArray<CommandInput>>([])
		const tool = bashTool((input) =>
			Effect.andThen(
				Ref.update(inputs, (all) => [...all, input]),
				answer,
			),
		)
		// fold's tool setup may ask for a FileSystem; bash never does.
		const bash = (params: unknown) =>
			callTool([tool], 'bash', params).pipe(Effect.provide(FileSystem.layerNoop({})))
		return { bash, inputs: Ref.get(inputs) }
	})

it.effect('returns stdout then stderr, running in /workspace by default', () =>
	Effect.gen(function* () {
		const { bash, inputs } = yield* fakeBash(Effect.succeed(output({ stdout: 'README\n', stderr: 'warning' })))

		expect(yield* bash({ command: 'ls' })).toEqual({ _tag: 'text', text: 'README\nwarning' })
		expect(yield* inputs).toEqual([{ command: 'ls', cwd: '/workspace', timeoutMs: 120_000 }])
	}),
)

it.effect('resolves workdir against /workspace and passes the timeout', () =>
	Effect.gen(function* () {
		const { bash, inputs } = yield* fakeBash(Effect.succeed(output({})))

		expect(yield* bash({ command: 'true', workdir: 'app/src', timeout_ms: 5_000 })).toEqual({
			_tag: 'text',
			text: '(no output)',
		})
		yield* bash({ command: 'true', workdir: '/tmp' })
		expect((yield* inputs).map(({ cwd, timeoutMs }) => ({ cwd, timeoutMs }))).toEqual([
			{ cwd: '/workspace/app/src', timeoutMs: 5_000 },
			{ cwd: '/tmp', timeoutMs: 120_000 },
		])
	}),
)

it.effect('fails with the output and exit code when the command fails', () =>
	Effect.gen(function* () {
		const { bash } = yield* fakeBash(Effect.succeed(output({ exitCode: 2, stderr: 'grep: nope: No such file\n' })))

		expect(yield* Effect.flip(bash({ command: 'grep x nope' }))).toEqual({
			_tag: 'failure',
			text: 'grep: nope: No such file\n\nCommand exited with code 2',
		})
	}),
)

it.effect('fails when the command times out', () =>
	Effect.gen(function* () {
		const { bash } = yield* fakeBash(Effect.succeed(output({ status: 'cancelled', exitCode: 130 })))

		expect(yield* Effect.flip(bash({ command: 'sleep 1000', timeout_ms: 10 }))).toMatchObject({
			text: expect.stringContaining('Command timed out after 10 milliseconds'),
		})
	}),
)

it.effect('rejects a bad timeout without running anything', () =>
	Effect.gen(function* () {
		const { bash, inputs } = yield* fakeBash(Effect.succeed(output({})))

		expect(yield* Effect.flip(bash({ command: 'ls', timeout_ms: 0 }))).toMatchObject({ _tag: 'failure' })
		expect(yield* inputs).toEqual([])
	}),
)

it.effect('keeps the end of long output', () =>
	Effect.gen(function* () {
		const lines = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join('\n')
		const { bash } = yield* fakeBash(Effect.succeed(output({ stdout: lines })))

		const result = yield* bash({ command: 'seq 2500' })
		expect(result).toMatchObject({ text: expect.stringMatching(/^\[Showing the last 2000 of 2500 lines\]\n/) })
		expect(result).toMatchObject({ text: expect.stringMatching(/line 2500$/) })
		expect(result).not.toMatchObject({ text: expect.stringContaining('line 500\n') })
	}),
)

it.effect('fails the tool call when the shell cannot run the command', () =>
	Effect.gen(function* () {
		const { bash } = yield* fakeBash(Effect.fail(new ShellError({ message: 'shell unavailable' })))

		expect(yield* Effect.flip(bash({ command: 'ls' }))).toEqual({
			_tag: 'failure',
			text: 'The shell could not run the command: shell unavailable',
		})
	}),
)
