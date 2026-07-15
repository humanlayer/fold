/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core'
import { render } from '@opentui/solid'
import { createSignal } from 'solid-js'

import { TuiApp } from '../../src/tui/App'
import { rootInputVerbLabel } from '../../src/tui/Converse'
import { makeSessionState, makeSessionStateFromEntries } from '../../src/tui/SessionState'
import { markChangeViewed, type ViewedPatchHashes } from '../../src/tui/ViewedChanges'

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
const [viewedPatchHashes, setViewedPatchHashes] = createSignal<ViewedPatchHashes>({})
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
	...(process.env.FOLD_TUI_EVENT_SUBAGENT_FIXTURE === '1'
		? [
				{
					_tag: 'assistant-message',
					seq: 6,
					ts: 6,
					agentId: 'agent_root',
					parentAgentId: null,
					toolCallId: null,
					messageId: 'msg_root_subagent',
					message: {
						role: 'assistant',
						content: [
							{
								type: 'tool-call',
								id: 'tool_subagent',
								name: 'subagent',
								params: { agent: 'researcher', prompt: 'Inspect the event-driven target input' },
								providerExecuted: false,
							},
						],
					},
					finish: null,
				},
			]
		: []),
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
	...(process.env.FOLD_TUI_STOPPED_SUBAGENT_FIXTURE === '1'
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
			state={() => ({
				...(process.env.FOLD_TUI_EVENT_SUBAGENT_FIXTURE === '1'
					? makeSessionStateFromEntries(subagentEntries, 'agent_root' as never)
					: makeSessionState(null)),
				status: status(),
				model: model(),
				allEntries: subagentEntries,
			})}
			cwd="/workspace/fold"
			sessionId="sess_terminal_control"
			mode="default"
			profile="default"
			gitSnapshot={() => ({
				_tag: 'ready',
				files: [
					{
						key: 'staged:src/staged.ts',
						group: 'staged',
						status: 'M',
						path: 'src/staged.ts',
						additions: 1,
						deletions: 1,
						diff: 'diff --git a/src/staged.ts b/src/staged.ts\n--- a/src/staged.ts\n+++ b/src/staged.ts\n@@ -1 +1 @@\n-old\n+new',
						expandedDiff:
							'diff --git a/src/staged.ts b/src/staged.ts\n--- a/src/staged.ts\n+++ b/src/staged.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context',
						patchHash: 'fixture-source-hash',
					},
					{
						key: 'untracked:notes file.md',
						group: 'untracked',
						status: '??',
						path: 'notes file.md',
						additions: 1,
						deletions: 0,
						diff: 'diff --git a/notes file.md b/notes file.md\n--- /dev/null\n+++ b/notes file.md\n@@ -0,0 +1 @@\n+fixture note',
						expandedDiff:
							'diff --git a/notes file.md b/notes file.md\n--- /dev/null\n+++ b/notes file.md\n@@ -0,0 +1 @@\n+fixture note',
						patchHash: 'fixture-notes-hash',
					},
				],
			})}
			viewedPatchHashes={viewedPatchHashes}
			onViewChange={(change) => setViewedPatchHashes((viewed) => markChangeViewed(viewed, change))}
			onRefreshGit={() => setNotice('CHANGES REFRESHED')}
			{...(process.env.FOLD_TUI_SUBAGENT_FIXTURE === '1' ? { initialSelectedAgentId: 'agent_researcher' } : {})}
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
