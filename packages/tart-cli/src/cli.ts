#!/usr/bin/env bun
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect } from 'effect'

import { main } from './Commands'

main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
