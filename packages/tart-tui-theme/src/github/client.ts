import { DEMO_FEED } from './fixtures'
import type { Feed, GhItem, RateLimit } from './types'

const API = 'https://api.github.com'
const PER_PAGE = 30
/** An unreachable network can hang `fetch` forever; cap every request. */
const REQUEST_TIMEOUT_MS = 8000

interface LoadOptions {
	readonly owner: string
	readonly repo: string
	/** Skip the network entirely and use the bundled fixtures. */
	readonly demo: boolean
}

/** Shape of the fields we actually read off the GitHub REST payloads. */
interface RawItem {
	number?: unknown
	title?: unknown
	state?: unknown
	draft?: unknown
	merged_at?: unknown
	user?: { login?: unknown } | null
	created_at?: unknown
	updated_at?: unknown
	comments?: unknown
	labels?: unknown
	body?: unknown
	html_url?: unknown
	head?: { ref?: unknown } | null
	base?: { ref?: unknown } | null
	pull_request?: unknown
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)

function parseLabels(v: unknown): string[] {
	if (!Array.isArray(v)) return []
	return v.flatMap((label) => {
		if (typeof label === 'string') return [label]
		if (label !== null && typeof label === 'object' && 'name' in label) {
			// The `in` check narrows `label` to something carrying `name`, so this
			// reads without an assertion.
			const name: unknown = label.name
			if (typeof name === 'string') return [name]
		}
		return []
	})
}

function normalize(raw: RawItem, kind: GhItem['kind']): GhItem {
	const headRef = raw.head ? str(raw.head.ref) : ''
	const baseRef = raw.base ? str(raw.base.ref) : ''
	return {
		kind,
		number: num(raw.number),
		title: str(raw.title, '(untitled)'),
		state: raw.state === 'closed' ? 'closed' : 'open',
		draft: raw.draft === true,
		merged: typeof raw.merged_at === 'string',
		author: raw.user ? str(raw.user.login, 'ghost') : 'ghost',
		createdAt: str(raw.created_at),
		updatedAt: str(raw.updated_at),
		comments: num(raw.comments),
		labels: parseLabels(raw.labels),
		body: str(raw.body),
		url: str(raw.html_url),
		// `exactOptionalPropertyTypes` forbids assigning `undefined` to an
		// optional prop, so omit the key entirely instead.
		...(headRef ? { headRef } : {}),
		...(baseRef ? { baseRef } : {}),
	}
}

/** Env vars first, then whatever `gh` is already logged in as. */
async function discoverToken(): Promise<string | null> {
	const fromEnv = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']
	if (fromEnv) return fromEnv

	try {
		const proc = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'ignore' })
		const out = (await new Response(proc.stdout).text()).trim()
		if ((await proc.exited) === 0 && out) return out
	} catch {
		// `gh` not installed — fall through to unauthenticated requests.
	}
	return null
}

/** `Date` → a compact "in 42m" / "in 1h 05m" countdown for the UI. */
function formatResetsIn(resetsAt: Date): string {
	const seconds = Math.max(0, Math.round((resetsAt.getTime() - Date.now()) / 1000))
	if (seconds < 60) return `in ${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `in ${minutes}m`
	const hours = Math.floor(minutes / 60)
	return `in ${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

function parseRateLimit(headers: Headers): RateLimit | null {
	const limit = headers.get('x-ratelimit-limit')
	const remaining = headers.get('x-ratelimit-remaining')
	const reset = headers.get('x-ratelimit-reset')
	if (!limit || !remaining || !reset) return null
	const resetsAt = new Date(Number(reset) * 1000)
	return {
		limit: Number(limit),
		remaining: Number(remaining),
		resetsAt,
		resetsIn: formatResetsIn(resetsAt),
	}
}

/**
 * Turn a non-2xx response into a human message. GitHub signals secondary rate
 * limits as **403 + `retry-after`** (not 429), and primary-limit exhaustion as
 * 403/429 with `x-ratelimit-remaining: 0`; surface both so the header shows why
 * we went dark instead of a bare status code.
 */
function describeFailure(path: string, res: Response): string {
	const status = res.status
	const endpoint = path.split('?')[0] ?? path
	if (status === 403 || status === 429) {
		const retryAfter = res.headers.get('retry-after')
		if (retryAfter) return `GitHub secondary rate limit — retry after ${retryAfter}s`
		if (res.headers.get('x-ratelimit-remaining') === '0') {
			const rl = parseRateLimit(res.headers)
			return rl ? `GitHub rate limit exhausted — resets ${rl.resetsIn ?? 'soon'}` : 'GitHub rate limit exhausted'
		}
		return `GitHub denied ${endpoint} (403 — private repo or bad token?)`
	}
	if (status === 404) return `repo/endpoint not found: ${endpoint} (404)`
	return `GET ${endpoint} -> ${status} ${res.statusText}`
}

/** A rejected request's reason as a string, with a friendly note for timeouts. */
function reasonText(reason: unknown): string {
	if (reason instanceof Error) {
		if (reason.name === 'TimeoutError' || reason.name === 'AbortError') {
			return `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
		}
		return reason.message
	}
	return String(reason)
}

/** Prefer an actionable rate-limit reason over a generic one when both lists fail. */
function combineReasons(pullsReason: unknown, issuesReason: unknown): string {
	const pulls = reasonText(pullsReason)
	const issues = reasonText(issuesReason)
	if (/rate limit/i.test(pulls)) return pulls
	if (/rate limit/i.test(issues)) return issues
	return pulls
}

/** Normalize a raw list payload, dropping PRs that the issues endpoint smuggles in. */
function parseItems(payload: unknown, kind: GhItem['kind']): GhItem[] {
	if (!Array.isArray(payload)) return []
	// `Array.isArray` narrows to `any[]`, so this annotation stands in for an
	// assertion. Every field is re-validated in `normalize`.
	const raw: RawItem[] = payload
	// The issues endpoint also returns pull requests. Anything carrying a
	// `pull_request` key is a PR wearing an issue costume — drop it.
	const rows = kind === 'issue' ? raw.filter((item) => item.pull_request === undefined) : raw
	return rows.map((item) => normalize(item, kind))
}

async function get(path: string, token: string | null): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'tart-tui-theme',
	}
	if (token) headers['Authorization'] = `Bearer ${token}`

	const res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
	if (!res.ok) {
		throw new Error(describeFailure(path, res))
	}
	return res
}

export async function loadFeed(options: LoadOptions): Promise<Feed> {
	const repo = `${options.owner}/${options.repo}`

	if (options.demo) {
		return { ...DEMO_FEED, repo, offlineReason: 'demo mode (--demo)' }
	}

	const token = await discoverToken()

	try {
		const base = `/repos/${options.owner}/${options.repo}`
		const query = `state=all&per_page=${PER_PAGE}&sort=updated&direction=desc`

		// `allSettled`, not `all`: a repo with issues (or pulls) disabled 404/410s
		// on one endpoint while the other is fine. `Promise.all` would reject the
		// pair and drop the whole feed to fixtures; here we keep whatever answered.
		const [pullsResult, issuesResult] = await Promise.allSettled([
			get(`${base}/pulls?${query}`, token),
			get(`${base}/issues?${query}`, token),
		])

		const pullsRes = pullsResult.status === 'fulfilled' ? pullsResult.value : null
		const issuesRes = issuesResult.status === 'fulfilled' ? issuesResult.value : null

		// Only fall back to fixtures when BOTH lists fail (nonexistent repo, no
		// network, or rate-limited) — never let the network take down the playground.
		if (!pullsRes && !issuesRes) {
			return {
				...DEMO_FEED,
				repo,
				offlineReason: combineReasons(
					pullsResult.status === 'rejected' ? pullsResult.reason : null,
					issuesResult.status === 'rejected' ? issuesResult.reason : null,
				),
			}
		}

		const pulls = pullsRes ? parseItems(await pullsRes.json(), 'pr') : []
		const issues = issuesRes ? parseItems(await issuesRes.json(), 'issue') : []

		// Rate limit comes from whichever response we actually have.
		const rateSource = pullsRes ?? issuesRes
		return {
			repo,
			pulls,
			issues,
			rateLimit: rateSource ? parseRateLimit(rateSource.headers) : null,
			offlineReason: null,
			authenticated: token !== null,
		}
	} catch (error) {
		// Any unexpected throw (e.g. malformed JSON) still lands on fixtures.
		const reason = error instanceof Error ? error.message : String(error)
		return { ...DEMO_FEED, repo, offlineReason: reason }
	}
}
