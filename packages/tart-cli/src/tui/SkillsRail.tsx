/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from '@opentui/core'
import { createEffect, Index } from 'solid-js'

import type { SkillView } from './Subagents'
import { theme } from './ThemeState'

export const SkillsRail = (props: {
	readonly skills: ReadonlyArray<SkillView>
	readonly selected: number
	readonly focused: boolean
	readonly onSelect: (index: number) => void
}) => {
	let scroller: ScrollBoxRenderable | undefined
	createEffect(() => {
		const skill = props.skills[props.selected]
		if (props.focused && skill !== undefined) scroller?.scrollChildIntoView(`skill:${skill.name}`)
	})
	return (
		<scrollbox ref={(value: ScrollBoxRenderable) => (scroller = value)} flexGrow={1} scrollY>
			<box flexDirection="column" paddingX={1}>
				<box height={1} flexDirection="row">
					<text fg={theme.color.textFaint} wrapMode="none">{`${props.skills.length} AVAILABLE`}</text>
					<box flexGrow={1} />
					<text fg={theme.color.inject} wrapMode="none">
						✦ USED
					</text>
					<text fg={theme.color.grid} wrapMode="none">
						{' '}
						◆ LOADED
					</text>
				</box>
				<Index
					each={props.skills}
					fallback={<text fg={theme.color.textFaint}>NO SKILLS IN SESSION ROSTER</text>}
				>
					{(skill, index) => (
						<box
							id={`skill:${skill().name}`}
							flexDirection="column"
							flexShrink={0}
							border={['top']}
							borderColor={theme.chrome.border}
							backgroundColor={
								props.focused && props.selected === index ? theme.color.raised : theme.color.panel
							}
							onMouseDown={() => props.onSelect(index)}
						>
							<box height={1} flexDirection="row">
								<text
									fg={
										skill().used
											? theme.color.inject
											: skill().loaded
												? theme.color.grid
												: theme.color.textDim
									}
									wrapMode="none"
								>
									{`${props.focused && props.selected === index ? '▸' : skill().used ? '✦' : skill().loaded ? '◆' : '·'} ${skill().name}`}
								</text>
								<box flexGrow={1} />
								<text
									fg={
										skill().used
											? theme.color.inject
											: skill().loaded
												? theme.color.grid
												: theme.color.textFaint
									}
									wrapMode="none"
								>
									{skill().used ? 'USED' : skill().loaded ? 'LOADED' : 'AVAILABLE'}
								</text>
							</box>
							<text fg={theme.color.textFaint} wrapMode="none" truncate>
								{skill().description}
							</text>
						</box>
					)}
				</Index>
			</box>
		</scrollbox>
	)
}
