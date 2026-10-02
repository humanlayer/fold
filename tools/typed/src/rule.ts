import type ts from 'typescript-compiler'

export type Severity = 'error' | 'off' | 'warn'

export type RuleDiagnostic = {
	column: number
	fileName: string
	line: number
	message: string
	ruleName: string
	severity?: Exclude<Severity, 'off'>
}

export type ReportedDiagnostic = Omit<RuleDiagnostic, 'ruleName' | 'severity'>

export type RuleContext = {
	checker: ts.TypeChecker
	options: Readonly<Record<string, unknown>>
	report: (diagnostic: ReportedDiagnostic) => void
	sourceFile: ts.SourceFile
}

export type TypedRule = {
	check: (context: RuleContext) => void
	name: string
}

export type WorkspaceRuleContext = {
	options: Readonly<Record<string, unknown>>
	report: (diagnostic: ReportedDiagnostic) => void
	rootDir: string
}

export type WorkspaceRule = {
	check: (context: WorkspaceRuleContext) => void
	name: string
}

export type AnyRule = TypedRule | WorkspaceRule
