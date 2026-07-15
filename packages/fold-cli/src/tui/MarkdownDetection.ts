export const containsMarkdown = (content: string): boolean =>
	/(^|\n)\s{0,3}(#{1,6}\s|>\s|[-+*]\s|\d+[.)]\s|```|~~~)/.test(content) ||
	/(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\n]+\*|_[^_\n]+_)/.test(content) ||
	/\n\s*\|?.+\|.+\n\s*\|?\s*:?-{3}/.test(content)
