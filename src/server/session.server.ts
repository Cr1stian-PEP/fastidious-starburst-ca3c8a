import { randomUUID } from 'node:crypto'
import { eq, inArray, isNull, lt } from 'drizzle-orm'
import {
  getCookie,
  getRequestProtocol,
  setCookie,
  setResponseHeader,
} from '@tanstack/react-start/server'
import { db } from '../../db/index.js'
import { reports, reportSessions } from '../../db/schema.js'
import { deleteReportsWhere } from './reports.server.js'

/**
 * Uploads are private to the browser visit that made them.
 *
 * Several people use this report at once, each on their own three exports, and
 * the files they upload are internal production and customer data. So a report
 * is stored against a session id held in an httpOnly cookie: a request only ever
 * sees the reports its own session uploaded, and a visit that arrives without a
 * usable cookie starts with three empty slots rather than inheriting whatever
 * the last person left on the page.
 *
 * The cookie deliberately has no Max-Age, so it dies with the browser session.
 * Because a shared workstation is often never closed, the server expires a
 * session independently as well: past IDLE_MS with no request, its uploads are
 * deleted and the next request gets a new, empty session.
 */
export const SESSION_COOKIE = 'mvr_session'

/** How long a session may sit idle before its uploads are deleted. */
export const SESSION_IDLE_MS = 30 * 60 * 1000

/** The same window, for the wording on screen. */
export const SESSION_IDLE_MINUTES = SESSION_IDLE_MS / 60_000

/** Session ids are ours (randomUUID); anything else in the cookie is ignored. */
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/i

// Report data must not be cached anywhere between the database and the tab that
// asked for it — a shared browser's history or an intermediary would otherwise
// be able to hand one person's report to the next.
function noStore() {
  try {
    setResponseHeader('cache-control', 'no-store')
  } catch {
    // Outside a request (never, in practice) there is no response to stamp.
  }
}

function isStale(lastSeenAt: Date | null): boolean {
  if (!lastSeenAt) return true
  return Date.now() - lastSeenAt.getTime() > SESSION_IDLE_MS
}

// Pushes the idle window out to now. The window is measured from the last time
// the session was used, so every path that uses one refreshes it.
async function touch(id: string): Promise<void> {
  await db
    .update(reportSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(reportSessions.id, id))
}

/**
 * Deletes each session row and every report it owns. Called for sessions that
 * have gone idle and for a cookie pointing at a session that no longer exists.
 */
async function deleteSessions(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await deleteReportsWhere(inArray(reports.sessionId, [...ids]))
  await db.delete(reportSessions).where(inArray(reportSessions.id, [...ids]))
}

/**
 * Drops everything no live session can reach: idle sessions, and reports left
 * behind from before uploads were session-scoped (which belong to no session and
 * so could never be shown, but shouldn't sit in the database either).
 *
 * Runs when a session is created rather than on every request — a new visit is
 * exactly the moment the report is meant to come up clean.
 */
async function purgeUnreachableReports(): Promise<void> {
  const cutoff = new Date(Date.now() - SESSION_IDLE_MS)
  const stale = await db
    .select({ id: reportSessions.id })
    .from(reportSessions)
    .where(lt(reportSessions.lastSeenAt, cutoff))

  await deleteSessions(stale.map((row) => row.id))
  await deleteReportsWhere(isNull(reports.sessionId))
}

async function startSession(): Promise<string> {
  await purgeUnreachableReports()

  const id = randomUUID()
  await db.insert(reportSessions).values({ id })

  setCookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    // No maxAge/expires: the cookie is dropped when the browser session ends.
    path: '/',
    // Locally the dev server is plain http, where a Secure cookie is discarded.
    secure: getRequestProtocol() === 'https',
  })

  return id
}

/**
 * The session that owns this request's reports, creating one when the request
 * arrives without a usable cookie. Every server function that touches uploaded
 * data goes through here, so nothing can be read or written unscoped.
 */
export async function ensureSession(): Promise<string> {
  noStore()

  const cookie = getCookie(SESSION_COOKIE)
  if (cookie && SESSION_ID_PATTERN.test(cookie)) {
    const [session] = await db
      .select()
      .from(reportSessions)
      .where(eq(reportSessions.id, cookie))

    if (session && !isStale(session.lastSeenAt)) {
      // Keeps the session alive for as long as it is being used, so the idle
      // window is measured from the last request rather than from the first.
      await touch(cookie)
      return cookie
    }

    // Idle too long, or a cookie left over from a session already purged:
    // whatever it still owns goes before a fresh session is handed out.
    await deleteSessions([cookie])
  }

  return startSession()
}

/**
 * Refreshes the idle window for the session the request already has, and
 * reports whether it is still there.
 *
 * Searching, filtering, sorting and expanding rows all happen in the browser,
 * so somebody working through a report makes no requests at all — and would sit
 * out the idle window with the whole report still on screen, only to find the
 * uploads gone the next time anything did reach the server. The dashboard pings
 * this while the tab is being used, so the window runs from what the person
 * last did rather than from the last upload.
 *
 * Unlike `ensureSession` it never starts a session: a keep-alive has nothing to
 * keep alive if the old one has gone, and handing out a fresh empty session
 * would only hide that from the page. `false` says exactly that, so the
 * dashboard can tell the user instead of letting an export come back empty.
 */
export async function keepSessionAlive(): Promise<boolean> {
  noStore()

  const cookie = getCookie(SESSION_COOKIE)
  if (!cookie || !SESSION_ID_PATTERN.test(cookie)) return false

  const [session] = await db
    .select()
    .from(reportSessions)
    .where(eq(reportSessions.id, cookie))

  if (!session || isStale(session.lastSeenAt)) return false

  await touch(cookie)
  return true
}

/**
 * Ends the current session and starts a new empty one: every report it uploaded
 * is deleted, which is what the dashboard's "Clear all" button does.
 */
export async function resetCurrentSession(): Promise<void> {
  noStore()

  const cookie = getCookie(SESSION_COOKIE)
  if (cookie && SESSION_ID_PATTERN.test(cookie)) await deleteSessions([cookie])
  await startSession()
}
