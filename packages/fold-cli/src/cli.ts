#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { layerLiveIdFactory } from '@humanlayer/fold-core'
import { Effect } from 'effect'

import { main } from './Commands'

main.pipe(Effect.provide(layerLiveIdFactory), Effect.provide(NodeServices.layer), NodeRuntime.runMain)
