#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { ManagedBinaries } from '@humanlayer/fold-agent'
import { layerLiveIdFactory } from '@humanlayer/fold-core'
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { main } from './Commands'

const platform = Layer.mergeAll(NodeServices.layer, layerLiveIdFactory, FetchHttpClient.layer)

main.pipe(Effect.provide(ManagedBinaries.layer.pipe(Layer.provideMerge(platform))), NodeRuntime.runMain)
