/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core'
import { createMemo, Index, Show, type Accessor } from 'solid-js'

import { containsMarkdown } from './MarkdownDetection'
import { MarkdownText } from './MarkdownText'
import type { ConversationRow } from './SessionState'
import { theme as tactical } from './ThemeState'
import { diffHeight, diffsForTool, skillInspection } from './ToolInspect'

const toolGlyph = (toolName: string | null): string => {
	switch (toolName) {
		case 'read':
			return '▤'
		case 'edit':
			return '✎'
		case 'write':
			return '✚'
		case 'subagent':
			return '★'
		case 'skill':
			return '✦'
		default:
			return '⚙'
	}
}

const toolColor = (toolName: string | null): string => {
	switch (toolName) {
		case 'read':
			return tactical.color.textDim
		case 'subagent':
			return tactical.color.inject
		case 'skill':
			return tactical.semantic.merged
		default:
			return tactical.color.core
	}
}

const assistantVisual = (
	row: ConversationRow,
): { readonly glyph: string; readonly color: string; readonly dim: boolean } =>
	row.status === 'partial'
		? { glyph: '◇', color: tactical.color.inject, dim: true }
		: { glyph: '◇', color: tactical.color.coreBright, dim: false }

export const rowVisual = (
	row: ConversationRow,
): { readonly glyph: string; readonly color: string; readonly dim: boolean } => {
	switch (row.kind) {
		case 'user':
			return { glyph: '›', color: tactical.color.grid, dim: false }
		case 'assistant':
			return assistantVisual(row)
		case 'reasoning':
			return { glyph: '∴', color: tactical.color.textDim, dim: true }
		case 'tool-call':
			return {
				glyph: row.status === 'interrupted' ? '⊘' : toolGlyph(row.toolName),
				color:
					row.status === 'error'
						? tactical.color.alert
						: row.status === 'interrupted'
							? tactical.color.inject
							: toolColor(row.toolName),
				dim: false,
			}
		case 'tool-result':
			return {
				glyph: row.isFailure ? '✕' : '⮑',
				color: row.isFailure ? tactical.color.alert : tactical.color.gridDim,
				dim: true,
			}
		case 'compaction':
			return { glyph: '⧗', color: tactical.color.grid, dim: true }
		case 'error':
			return { glyph: '✕', color: tactical.color.alert, dim: false }
	}
}

export const EventRow = (props: { readonly row: Accessor<ConversationRow> }) => {
	const visual = createMemo(() => rowVisual(props.row()))
	const isToolCall = createMemo(() => props.row().kind === 'tool-call')
	const bodyColor = createMemo(() =>
		isToolCall() ? tactical.color.textDim : visual().dim ? tactical.color.textDim : tactical.color.text,
	)
	const rendersMarkdown = createMemo(
		() =>
			['user', 'assistant', 'reasoning', 'compaction'].includes(props.row().kind) &&
			containsMarkdown(props.row().text),
	)
	return (
		<box flexDirection="row" flexShrink={0} width="100%" paddingLeft={1} paddingRight={1}>
			<box width={3} flexShrink={0}>
				<text fg={visual().color} wrapMode="none">
					{visual().glyph}
				</text>
			</box>
			<box width={12} flexShrink={0}>
				<text
					fg={visual().color}
					attributes={visual().dim ? TextAttributes.DIM : TextAttributes.NONE}
					wrapMode="none"
				>
					{props.row().label}
				</text>
			</box>
			<box flexGrow={1} flexShrink={1}>
				{rendersMarkdown() ? (
					<MarkdownText content={props.row().text} tone={visual().dim ? 'muted' : 'normal'} />
				) : (
					<text
						fg={bodyColor()}
						attributes={visual().dim ? TextAttributes.DIM : TextAttributes.NONE}
						wrapMode="word"
					>
						{props.row().text}
					</text>
				)}
			</box>
		</box>
	)
}

const DetailSection = (props: { readonly title: string; readonly text: string; readonly muted?: boolean }) => (
	<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
		<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
			{props.title}
		</text>
		<text fg={props.muted ? tactical.color.textDim : tactical.color.text} wrapMode="word">
			{props.text.length === 0 ? '(empty)' : props.text}
		</text>
	</box>
)

type DetailField = { readonly name: string; readonly value: string }

const detailFields = (text: string): ReadonlyArray<DetailField> => {
	try {
		const value: unknown = JSON.parse(text)
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ name: 'VALUE', value: text }]
		return Object.entries(value).map(([name, field]) => ({
			name: name.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase(),
			value: typeof field === 'string' ? field : (JSON.stringify(field, null, 2) ?? String(field)),
		}))
	} catch {
		return [{ name: 'VALUE', value: text }]
	}
}

const DetailFields = (props: { readonly title: string; readonly text: string }) => {
	const fields = createMemo(() => detailFields(props.text))
	return (
		<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
			<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
				{props.title}
			</text>
			<Index each={fields()}>
				{(field) => (
					<box flexDirection="row" flexShrink={0} width="100%">
						<text fg={tactical.color.textDim} width={16} flexShrink={0} wrapMode="none">
							{field().name}
						</text>
						<text fg={tactical.color.text} flexGrow={1} flexShrink={1} wrapMode="word">
							{field().value}
						</text>
					</box>
				)}
			</Index>
		</box>
	)
}

export const EventDetail = (props: { readonly row: Accessor<ConversationRow> }) => {
	const visual = createMemo(() => rowVisual(props.row()))
	const isToolCall = createMemo(() => props.row().kind === 'tool-call')
	const input = createMemo(() => props.row().inputText)
	const executedInput = createMemo(() => props.row().executedInputText)
	const result = createMemo(() => props.row().resultText)
	const diffs = createMemo(() => diffsForTool(props.row().toolName, executedInput() ?? input()))
	const readContent = createMemo(() => (props.row().toolName === 'read' ? result() : null))
	const loadedSkill = createMemo(() => (props.row().toolName === 'skill' ? skillInspection(result()) : null))

	return props.row().kind === 'compaction' ? (
		<box flexDirection="column" flexShrink={0} width="100%">
			<box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} gap={1}>
				<text fg={visual().color} attributes={TextAttributes.BOLD} wrapMode="none">
					{`${visual().glyph} COMPACTION`}
				</text>
				<box flexGrow={1} />
				<text fg={tactical.color.textDim} wrapMode="none">
					CHECKPOINT
				</text>
			</box>
			<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
				<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
					PROMPT
				</text>
				<MarkdownText content={props.row().inputText ?? ''} tone="muted" />
			</box>
			<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
				<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
					SUMMARY
				</text>
				<MarkdownText content={props.row().resultText ?? props.row().text} tone="normal" />
			</box>
			{props.row().executedInputText !== null ? (
				<DetailSection title="POST-COMPACTION INSTRUCTIONS" text={props.row().executedInputText ?? ''} muted />
			) : null}
		</box>
	) : (
		<Show when={isToolCall()} fallback={<EventRow row={props.row} />}>
			<box flexDirection="column" flexShrink={0} width="100%">
				<box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} gap={1}>
					<text fg={visual().color} attributes={TextAttributes.BOLD} wrapMode="none">
						{`${visual().glyph} ${props.row().label}`}
					</text>
					<box flexGrow={1} />
					<text fg={visual().color} wrapMode="none">
						{props.row().status.toUpperCase()}
					</text>
				</box>
				{input() !== null ? <DetailFields title="ARGUMENTS" text={input() ?? ''} /> : null}
				{executedInput() !== null ? (
					<DetailFields title="EXECUTED ARGUMENTS" text={executedInput() ?? ''} />
				) : null}
				{result() !== null && loadedSkill() === null ? (
					<DetailSection title={props.row().isFailure ? 'ERROR RESULT' : 'RESULT'} text={result() ?? ''} />
				) : result() === null ? (
					<DetailSection title="RESULT" text="Tool is still running" muted />
				) : null}
				{readContent() !== null ? <DetailSection title="FILE CONTENT" text={readContent() ?? ''} /> : null}
				{loadedSkill() !== null ? (
					<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
						<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
							RESULT · SKILL.MD
						</text>
						<text fg={tactical.color.textDim} wrapMode="word">
							{loadedSkill()?.openingTag ?? ''}
						</text>
						{loadedSkill()?.relativePathNote !== null ? (
							<text fg={tactical.color.textDim} wrapMode="word">
								{loadedSkill()?.relativePathNote ?? ''}
							</text>
						) : null}
						<MarkdownText content={loadedSkill()?.markdown ?? ''} tone="normal" />
						<text fg={tactical.color.textDim} wrapMode="word">
							{loadedSkill()?.closingTag ?? ''}
						</text>
						{loadedSkill()?.trailingText !== null ? (
							<text fg={tactical.color.textDim} wrapMode="word">
								{loadedSkill()?.trailingText ?? ''}
							</text>
						) : null}
					</box>
				) : null}
				<Index each={diffs()}>
					{(diff) => (
						<box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
							<text fg={tactical.color.coreBright} attributes={TextAttributes.BOLD} wrapMode="none">
								DIFF
							</text>
							<diff
								diff={diff()}
								view="unified"
								width="100%"
								height={diffHeight(diff())}
								flexShrink={0}
								wrapMode="word"
								showLineNumbers
								fg={tactical.color.text}
								addedSignColor={tactical.color.grid}
								removedSignColor={tactical.color.alert}
								lineNumberFg={tactical.color.textDim}
							/>
						</box>
					)}
				</Index>
			</box>
		</Show>
	)
}

export const EventIndexRow = (props: {
	readonly row: Accessor<ConversationRow>
	readonly selected: Accessor<boolean>
}) => {
	const visual = createMemo(() => rowVisual(props.row()))
	const sequence = createMemo(() => (props.row().seq === null ? '···' : String(props.row().seq)).padStart(4, ' '))
	const status = createMemo(() => {
		if (props.row().kind !== 'tool-call') return ''
		if (props.row().status === 'running') return 'run'
		if (props.row().status === 'interrupted') return 'intr'
		if (props.row().status === 'error') return 'err'
		return 'done'
	})
	const summary = createMemo(() =>
		props
			.row()
			.text.replaceAll('\n', ' ')
			.replace(/(```|`|\*\*|__|[*_>#])/g, '')
			.trim(),
	)
	return (
		<box
			id={`event:${props.row().key}`}
			flexDirection="row"
			width="100%"
			height={1}
			paddingLeft={0}
			paddingRight={0}
			backgroundColor={props.selected() ? tactical.color.raised : tactical.color.panel}
		>
			<box width={18} flexShrink={0}>
				<text wrapMode="none">
					<span style={{ fg: tactical.color.coreBright }}>{props.selected() ? '▸' : ' '}</span>
					<span style={{ fg: tactical.color.textFaint }}>{sequence()}</span>
					<span style={{ fg: visual().color }}>
						{` ${visual().glyph} ${props.row().label.toLowerCase().padEnd(9, ' ')} `}
					</span>
				</text>
			</box>
			<text fg={props.selected() ? tactical.color.text : tactical.color.textDim} flexGrow={1} wrapMode="none">
				{summary()}
			</text>
			<text fg={visual().color} width={5} wrapMode="none">
				{status()}
			</text>
		</box>
	)
}
