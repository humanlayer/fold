#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { ManagedBinaries, Photon } from '@humanlayer/fold-agent'
import { layerLiveIdFactory } from '@humanlayer/fold-core'
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { main } from './Commands'

/** Every host service fold's tools and sessions need, provided once for the whole CLI. */
const platform = Layer.mergeAll(NodeServices.layer, layerLiveIdFactory, FetchHttpClient.layer, Photon.layer)

main.pipe(Effect.provide(ManagedBinaries.layer.pipe(Layer.provideMerge(platform))), NodeRuntime.runMain)
