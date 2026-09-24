/** Minimal reader for the Amazon Bedrock fields supported in Codex CLI config.toml. */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Effect, FileSystem, Option, Schema } from 'effect'
import { parse } from 'smol-toml'

export type CodexAmazonBedrockConfig = {
	readonly provider: 'amazon-bedrock' | 'amazon-bedrock-runtime'
	readonly profile?: string
	readonly region?: string
	readonly model?: string
	readonly baseUrl?: string
}

export class CodexConfigError extends Schema.TaggedError<CodexConfigError>()('CodexConfigError', {
	reason: Schema.Literals(['Malformed', 'ReadFailed']),
	message: Schema.String,
}) {}

const AwsConfig = Schema.Struct({
	profile: Schema.optionalKey(Schema.String),
	region: Schema.optionalKey(Schema.String),
})
const ProviderConfig = Schema.Struct({
	base_url: Schema.optionalKey(Schema.String),
	aws: Schema.optionalKey(AwsConfig),
})
const RootConfig = Schema.Struct({
	model_provider: Schema.optionalKey(Schema.String),
	model: Schema.optionalKey(Schema.String),
	model_providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeRootConfig = Schema.decodeUnknownOption(RootConfig)
const decodeProviderConfig = Schema.decodeUnknownOption(ProviderConfig)

export type ReadCodexConfigOptions = {
	readonly codexHome?: string
}

/** Read supported Bedrock configuration, returning none when the file or selection is absent. */
export const readCodexAmazonBedrockConfig = (
	options?: ReadCodexConfigOptions,
): Effect.Effect<Option.Option<CodexAmazonBedrockConfig>, CodexConfigError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const codexHome = options?.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
		const configPath = join(codexHome, 'config.toml')
		const contents = yield* fs.readFileString(configPath).pipe(
			Effect.map<string, string | null>((content) => content),
			Effect.catchReasons('PlatformError', { NotFound: () => Effect.succeed(null) }),
			Effect.mapError(
				() =>
					new CodexConfigError({
						reason: 'ReadFailed',
						message: `Failed to read Codex config at ${configPath}`,
					}),
			),
		)
		if (contents === null) return Option.none<CodexAmazonBedrockConfig>()

		const parsed = yield* Effect.try({
			try: () => parse(contents),
			catch: () =>
				new CodexConfigError({ reason: 'Malformed', message: `Malformed Codex config at ${configPath}` }),
		})
		const root = decodeRootConfig(parsed)
		if (Option.isNone(root)) {
			return yield* new CodexConfigError({
				reason: 'Malformed',
				message: `Malformed Codex config at ${configPath}`,
			})
		}
		if (root.value.model_provider !== 'amazon-bedrock' && root.value.model_provider !== 'amazon-bedrock-runtime') {
			return Option.none<CodexAmazonBedrockConfig>()
		}

		const providerValue = root.value.model_providers?.[root.value.model_provider]
		const provider = providerValue === undefined ? Option.none() : decodeProviderConfig(providerValue)
		if (providerValue !== undefined && Option.isNone(provider)) {
			return yield* new CodexConfigError({
				reason: 'Malformed',
				message: `Malformed Codex config at ${configPath}`,
			})
		}

		const aws = Option.isSome(provider) ? provider.value.aws : undefined
		const result: {
			provider: 'amazon-bedrock' | 'amazon-bedrock-runtime'
			profile?: string
			region?: string
			model?: string
			baseUrl?: string
		} = { provider: root.value.model_provider }
		if (aws?.profile !== undefined) result.profile = aws.profile
		if (aws?.region !== undefined) result.region = aws.region
		if (root.value.model !== undefined) result.model = root.value.model
		if (Option.isSome(provider) && provider.value.base_url !== undefined) result.baseUrl = provider.value.base_url
		return Option.some(result)
	}).pipe(Effect.withSpan('fold.codexConfig.read'))
