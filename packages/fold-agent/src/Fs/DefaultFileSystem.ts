/** Resolve the working directory a tool handler should resolve relative paths against. */
export const cwdFor = (options?: { readonly cwd?: string }): string => options?.cwd ?? process.cwd()
