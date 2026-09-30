import type { RuleTester } from 'oxlint/plugins-dev'

type Rule = Parameters<RuleTester['run']>[1]
interface Options {
	readonly allowedHeightUtilities?: ReadonlyArray<string>
	readonly ignoredPathMarkers?: ReadonlyArray<string>
}
type VisitorObject = ReturnType<NonNullable<Rule['create']>>
type JSXOpeningElementNode = Parameters<NonNullable<VisitorObject['JSXOpeningElement']>>[0]
type JSXElementNode = Extract<JSXOpeningElementNode['parent'], { type: 'JSXElement' }>
type JSXChildNode = JSXElementNode['children'][number]

const contentIntrinsicElements = new Set([
	'a',
	'button',
	'dd',
	'dt',
	'figcaption',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'label',
	'legend',
	'li',
	'p',
	'summary',
])

const directContentElements = new Set(['article', 'div', 'footer', 'header', 'main', 'section', 'span'])

const fixedHeightControlElements = new Set(['input', 'select', 'textarea'])

const visualIntrinsicElements = new Set(['canvas', 'iframe', 'img', 'picture', 'svg', 'video'])

const mediaIntrinsicElements = new Set(['canvas', 'img', 'picture', 'video'])

const relativeHeightUtilities = new Set([
	'h-auto',
	'h-dvh',
	'h-fit',
	'h-full',
	'h-lvh',
	'h-max',
	'h-min',
	'h-screen',
	'h-svh',
	'size-auto',
	'size-fit',
	'size-full',
	'size-max',
	'size-min',
])

const semanticGeometricHeightUtilities = new Set(['h-chart', 'h-panel', 'h-skeleton-line', 'h-table-row'])

const contentComponentName =
	/(?:Badge|Button|Chip|Description|Heading|Label|Link|ListBoxItem|MenuItem|Option|Paragraph|Tag|Text|Title)$/

const fixedHeightControlComponentName = /(?:ComboBox|Input|SearchBar|SearchField|Select|TextArea|TextField)$/

const fixedHeightControlComponentNames = new Set(['Group'])

const visualComponentName = /(?:Avatar|Icon|Illustration|Image|Logo|Spinner|Svg)$/

const mediaComponentName = /(?:Avatar|Illustration|Image)$/

const _elementName = ({ node }: { node: JSXOpeningElementNode }) =>
	node.name.type === 'JSXIdentifier' ? node.name.name : undefined

const _hasAttribute = ({ name, node }: { name: string; node: JSXOpeningElementNode }) =>
	node.attributes.some(
		(attribute) =>
			attribute.type === 'JSXAttribute' &&
			attribute.name.type === 'JSXIdentifier' &&
			attribute.name.name === name,
	)

const _isVisibleExpression = ({ node }: { node: JSXChildNode }) =>
	node.type === 'JSXExpressionContainer' && node.expression.type !== 'JSXEmptyExpression'

const _hasTextualContent = ({ children }: { children: JSXElementNode['children'] }): boolean =>
	children.some((child) => {
		if (child.type === 'JSXText') {
			return child.value.trim().length > 0
		}

		if (_isVisibleExpression({ node: child })) {
			return true
		}

		if (child.type === 'JSXFragment') {
			return _hasTextualContent({ children: child.children })
		}

		if (child.type !== 'JSXElement') {
			return false
		}

		const name = _elementName({ node: child.openingElement })

		if (name !== undefined && (visualIntrinsicElements.has(name) || visualComponentName.test(name))) {
			return false
		}

		return _hasTextualContent({ children: child.children })
	})

const _hasDirectTextualContent = ({ children }: { children: JSXElementNode['children'] }) =>
	children.some((child) => child.type === 'JSXText' && child.value.trim().length > 0)

const _hasConfidentTextualContent = ({ children }: { children: JSXElementNode['children'] }): boolean =>
	children.some((child) => {
		if (child.type === 'JSXText') {
			return child.value.trim().length > 0
		}

		if (child.type === 'JSXFragment') {
			return _hasConfidentTextualContent({ children: child.children })
		}

		if (child.type !== 'JSXElement') {
			return false
		}

		const name = _elementName({ node: child.openingElement })

		if (name !== undefined && (visualIntrinsicElements.has(name) || visualComponentName.test(name))) {
			return false
		}

		return _hasConfidentTextualContent({ children: child.children })
	})

const _hasMediaContent = ({ children }: { children: JSXElementNode['children'] }): boolean =>
	children.some((child) => {
		if (child.type === 'JSXFragment') {
			return _hasMediaContent({ children: child.children })
		}

		if (child.type !== 'JSXElement') {
			return false
		}

		const name = _elementName({ node: child.openingElement })

		if (name !== undefined && (mediaIntrinsicElements.has(name) || mediaComponentName.test(name))) {
			return true
		}

		return _hasMediaContent({ children: child.children })
	})

const _utilityName = ({ token }: { token: string }) => token.split(':').at(-1)?.replace(/^!/, '')

const _fixedHeightUtilities = ({
	allowedHeightUtilities,
	source,
}: {
	allowedHeightUtilities: ReadonlySet<string>
	source: string
}) => {
	const utilities = new Set<string>()

	for (const match of source.matchAll(/[^\s"'`(){}>,]+/g)) {
		const token = match[0]
		const utility = _utilityName({ token })

		if (
			utility === undefined ||
			relativeHeightUtilities.has(utility) ||
			allowedHeightUtilities.has(utility) ||
			(!utility.startsWith('h-') && !utility.startsWith('size-'))
		) {
			continue
		}

		utilities.add(token)
	}

	return [...utilities]
}

const rule: Rule = {
	meta: {
		type: 'problem' as const,
		docs: {
			description: 'Require content-bearing web elements to derive their height from typography and padding.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					allowedHeightUtilities: {
						type: 'array',
						items: { type: 'string' },
					},
					ignoredPathMarkers: {
						type: 'array',
						items: { type: 'string' },
					},
				},
				additionalProperties: false,
			},
		],
	},
	create(context) {
		const filename = (context.filename ?? '').replaceAll('\\', '/')
		const options = (context.options[0] ?? {}) as Options
		const allowedHeightUtilities = new Set([
			...semanticGeometricHeightUtilities,
			...(options.allowedHeightUtilities ?? []),
		])
		const ignoredPathMarkers = options.ignoredPathMarkers ?? ['/native/']

		if (!filename.endsWith('.tsx') || ignoredPathMarkers.some((marker) => filename.includes(marker))) {
			return {}
		}

		return {
			JSXOpeningElement(node) {
				const name = _elementName({ node })
				const element = node.parent

				if (
					name === undefined ||
					element.type !== 'JSXElement' ||
					_hasAttribute({ name: 'aria-hidden', node }) ||
					visualIntrinsicElements.has(name) ||
					visualComponentName.test(name) ||
					((name === 'a' || name === 'Link') && _hasMediaContent({ children: element.children }))
				) {
					return
				}

				const isContentBearing =
					contentIntrinsicElements.has(name) ||
					fixedHeightControlElements.has(name) ||
					fixedHeightControlComponentName.test(name) ||
					fixedHeightControlComponentNames.has(name) ||
					(directContentElements.has(name) && _hasDirectTextualContent({ children: element.children })) ||
					(contentComponentName.test(name) && _hasTextualContent({ children: element.children }))

				if (!isContentBearing) {
					return
				}

				for (const attribute of node.attributes) {
					if (
						attribute.type !== 'JSXAttribute' ||
						attribute.name.type !== 'JSXIdentifier' ||
						attribute.name.name !== 'className'
					) {
						continue
					}

					const utilities = _fixedHeightUtilities({
						allowedHeightUtilities,
						source: context.sourceCode.getText(attribute),
					}).filter((token) => {
						const utility = _utilityName({ token })

						return (
							utility?.startsWith('size-') !== true ||
							(!_hasAttribute({ name: 'aria-label', node }) &&
								_hasConfidentTextualContent({ children: element.children }))
						)
					})

					if (utilities.length === 0) {
						continue
					}

					context.report({
						node: attribute,
						message: `Content-bearing elements should derive their height from line-height and vertical padding instead of ${utilities.join(', ')}. Use min-h-* for a required minimum or an approved geometric utility when the fixed height is intentional.`,
					})
				}
			},
		}
	},
}

export default rule
