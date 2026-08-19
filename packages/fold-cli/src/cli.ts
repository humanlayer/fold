#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { layerLiveIdFactory } from '@humanlayer/fold-core'
import { Effect, Layer } from 'effect'

import { main } from './Commands'

main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, layerLiveIdFactory)), NodeRuntime.runMain)
