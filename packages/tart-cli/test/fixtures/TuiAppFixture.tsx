/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { createSignal } from 'solid-js'

import { TuiApp } from '../../src/tui/App'
import { rootInputVerbLabel } from '../../src/tui/Converse'
import { makeSessionState } from '../../src/tui/SessionState'

let resolveDestroyed: (() => void) | undefined
const destroyed = new Promise<void>((resolve) => {
	resolveDestroyed = resolve
})
const renderer = await createCliRenderer({
	targetFps: 30,
	exitOnCtrlC: false,
	consoleMode: 'disabled',
	useKittyKeyboard: {},
	onDestroy: () => resolveDestroyed?.(),
})
const [status, setStatus] = createSignal<'RUNNING' | 'IDLE' | 'STOPPED'>('IDLE')
const [notice, setNotice] = createSignal<string | null>(null)
const [targetNotice, setTargetNotice] = createSignal<{ readonly agentId: string; readonly text: string } | null>(null)
const [model, setModel] = createSignal('unresolved')
const fixtureModel = {
	providerId: 'anthropic',
	providerKind: 'anthropic',
	modelId: 'fixture-model',
	role: null,
	requestedReasoningLevel: 'off',
	thinking: { _tag: 'disabled' },
}
const subagentEntries = [
	{
		_tag: 'agent_started',
		seq: 0,
		ts: 0,
		agentId: 'agent_root',
		parentAgentId: null,
		toolCallId: null,
		mode: 'fresh',
		model: fixtureModel,
		tools: [],
		skill: null,
		fork: null,
		agentType: null,
	},
	{
		_tag: 'system-message',
		seq: 2,
		ts: 2,
		agentId: 'agent_root',
		parentAgentId: null,
		toolCallId: null,
		messages: [
			'<available_skills><skill><name>effect-program-design</name><description>Design Effect programs</description></skill><skill><name>terminal-control</name><description>Drive terminal apps</description></skill></available_skills>',
		],
	},
	{
		_tag: 'system-message',
		seq: 3,
		ts: 3,
		agentId: 'agent_researcher',
		parentAgentId: null,
		toolCallId: null,
		messages: [
			'<available_skills><skill><name>effect-program-design</name><description>Design Effect programs</description></skill><skill><name>terminal-control</name><description>Drive terminal apps</description></skill></available_skills>',
		],
	},
	{
		_tag: 'assistant-message',
		seq: 4,
		ts: 4,
		agentId: 'agent_researcher',
		parentAgentId: null,
		toolCallId: null,
		messageId: 'msg_researcher_skill',
		message: {
			role: 'assistant',
			content: [
				{
					type: 'tool-call',
					id: 'tool_researcher_skill',
					name: 'skill',
					params: { name: 'terminal-control' },
					providerExecuted: false,
				},
			],
		},
		finish: null,
	},
	...(process.env.TART_TUI_STOPPED_SUBAGENT_FIXTURE === '1'
		? [
				{
					_tag: 'agent-finished',
					seq: 5,
					ts: 5,
					agentId: 'agent_researcher',
					parentAgentId: null,
					toolCallId: null,
					outcome: 'completed',
					resultText: 'research complete',
					reason: null,
				},
			]
		: []),
	{
		_tag: 'agent_started',
		seq: 1,
		ts: 1,
		agentId: 'agent_researcher',
		parentAgentId: 'agent_root',
		toolCallId: 'tool_subagent',
		agentType: 'researcher',
		mode: 'fresh',
		model: fixtureModel,
		tools: [],
		skill: null,
		fork: null,
	},
] as never

await render(
	() => (
		<TuiApp
			state={() => ({ ...makeSessionState(null), status: status(), model: model(), allEntries: subagentEntries })}
			cwd="/workspace/tart"
			sessionId="sess_terminal_control"
			mode="default"
			profile="default"
			{...(process.env.TART_TUI_SUBAGENT_FIXTURE === '1' ? { initialSelectedAgentId: 'agent_researcher' } : {})}
			notice={notice}
			targetNotice={targetNotice}
			onCompact={() => setNotice('COMPACTED')}
			onSubmit={(verb, text) => {
				setNotice(`${rootInputVerbLabel(verb)} RECEIVED · ${text.replaceAll('\n', ' / ')}`)
				setStatus('RUNNING')
			}}
			onInterrupt={() => {
				setNotice('INTERRUPT REQUESTED')
				setStatus('STOPPED')
			}}
			onTargetSubmit={(agentId, _text, verb) =>
				setTargetNotice({ agentId, text: verb === 'send' ? 'TARGET RESUME RECEIVED' : 'TARGET STEER RECEIVED' })
			}
			onTargetInterrupt={(agentId) => {
				setTargetNotice({ agentId, text: 'TARGET INTERRUPT REQUESTED' })
				setModel('target-interrupted')
			}}
			onInjectSkill={(skill, agentId) => {
				if (agentId === null) setNotice(`SKILL INJECTED · ${skill}`)
				else setTargetNotice({ agentId, text: `SKILL INJECTED · ${skill}` })
			}}
			onNewSession={() => {
				setNotice('NEW SESSION REQUESTED')
				setModel('new-session-requested')
			}}
			onBackToSessions={() => {
				setNotice('SESSION LIST REQUESTED')
				setModel('session-list-requested')
			}}
			onCopySessionId={() => setNotice('SESSION ID COPIED')}
		/>
	),
	renderer,
)
renderer.start()
await destroyed
