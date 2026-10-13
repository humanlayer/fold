/**
 * Every tool the coding and RLM modes advertise - root tools and every subagent's and fork agent's
 * tools, with and without the RPI roster - must convert to a JSON Schema that OpenAI's strict tool
 * schemas accept. The conversion is the one the OpenAI provider runs in `prepareTools`
 * (`Tool.getJsonSchema` with `toCodecOpenAI`), which throws for a non-object root or a root anyOf
 * (for example `Schema.Struct({})`, which also accepts arrays). Regression for list_agents.
 */
import { tmpdir } from 'node:os'

import { expect, it } from '@effect/vitest'
import { collectAgentDefinitions, customModel, type FoldModel } from '@humanlayer/fold-core'
import { Effect, Stream } from 'effect'
import { LanguageModel, Tool } from 'effect/ai'
import { toCodecOpenAI } from 'effect/ai/OpenAiStructuredOutput'

import { defaultCodingMode, layerCodingToolServices, rlmMode, type FoldMode, type ModeModels } from '../../src/index'

const model: FoldModel = customModel({
	activeModel: {
		providerId: 'test',
		providerKind: 'openai-compatible',
		modelId: 'schema-check',
		role: null,
		requestedReasoningLevel: 'off',
		reasoning: { _tag: 'disabled' },
	},
	make: LanguageModel.make({ generateText: () => Effect.die(new Error('unused')), streamText: () => Stream.empty }),
})
const models: ModeModels = { primary: model, smart: model, fast: model, orchestrator: model }

/** Root tools plus every reachable subagent and fork-agent tool, deduplicated by value. */
const advertisedTools = (mode: FoldMode, rpi: boolean) =>
	Effect.gen(function* () {
		const rootTools = mode.buildTools({ cwd: tmpdir(), models, rpi })
		const definitions = yield* collectAgentDefinitions(rootTools)
		const all = [
			...rootTools,
			...definitions.subagents.flatMap((definition) => definition.tools ?? []),
			...definitions.forkAgents.flatMap((definition) => definition.tools),
		]
		return [...new Set(all)]
	})

for (const mode of [defaultCodingMode, rlmMode]) {
	for (const rpi of [false, true]) {
		it.effect(`${mode.name} mode (rpi ${rpi}) advertises only OpenAI-compatible tool schemas`, () =>
			Effect.gen(function* () {
				const tools = yield* advertisedTools(mode, rpi)
				const names = new Set(tools.map((tool) => tool.name))
				expect(names).toContain('subagent')
				expect(names).toContain('list_agents')
				expect(names).toContain('stop_agent')
				expect(names).toContain('send_message')

				for (const foldTool of tools) {
					const contribution = yield* foldTool.init
					const schema = (() => {
						try {
							return Tool.getJsonSchema(contribution.tool, { transformer: toCodecOpenAI })
						} catch (error) {
							throw new Error(`tool ${foldTool.name}: ${String(error)}`, { cause: error })
						}
					})()
					expect(schema, foldTool.name).toMatchObject({ type: 'object' })
					expect(schema, foldTool.name).not.toHaveProperty('anyOf')
					expect(schema, foldTool.name).not.toHaveProperty('oneOf')
				}
			}).pipe(Effect.scoped, Effect.provide(layerCodingToolServices({ outputDirectory: tmpdir() }))),
		)
	}
}
