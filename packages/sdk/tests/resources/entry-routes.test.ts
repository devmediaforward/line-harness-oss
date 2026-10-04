import { describe, it, expect, vi } from 'vitest'
import { EntryRoutesResource } from '../../src/resources/entry-routes.js'
import type { HttpClient } from '../../src/http.js'

function mockHttp(data: unknown): HttpClient {
  return {
    get: vi.fn().mockResolvedValue({ success: true, data }),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as HttpClient
}

describe('EntryRoutesResource', () => {
  it('list() calls GET /api/entry-routes', async () => {
    const routes = [{ id: 'er_1', refCode: 'lp-a', name: 'LP A', isActive: true }]
    const http = mockHttp(routes)
    const result = await new EntryRoutesResource(http).list()
    expect(http.get).toHaveBeenCalledWith('/api/entry-routes')
    expect(result).toEqual(routes)
  })

  it('funnel() calls GET /api/entry-routes/:id/funnel', async () => {
    const funnel = { click_count: 10, friend_add_count: 5, form_submission_count: 2, cv_count: 1 }
    const http = mockHttp(funnel)
    const result = await new EntryRoutesResource(http).funnel('er_1')
    expect(http.get).toHaveBeenCalledWith('/api/entry-routes/er_1/funnel')
    expect(result).toEqual(funnel)
  })

  it('summary() without account has no query', async () => {
    const summary = { routes: [], totalFriends: 0, friendsWithRef: 0, friendsWithoutRef: 0 }
    const http = mockHttp(summary)
    const result = await new EntryRoutesResource(http).summary()
    expect(http.get).toHaveBeenCalledWith('/api/analytics/ref-summary')
    expect(result).toEqual(summary)
  })

  it('summary() uses defaultAccountId', async () => {
    const http = mockHttp({ routes: [], totalFriends: 0, friendsWithRef: 0, friendsWithoutRef: 0 })
    await new EntryRoutesResource(http, 'acc_default').summary()
    expect(http.get).toHaveBeenCalledWith('/api/analytics/ref-summary?lineAccountId=acc_default')
  })

  it('summary() explicit lineAccountId overrides default and is encoded', async () => {
    const http = mockHttp({ routes: [], totalFriends: 0, friendsWithRef: 0, friendsWithoutRef: 0 })
    await new EntryRoutesResource(http, 'acc_default').summary({ lineAccountId: 'acc 1&x' })
    expect(http.get).toHaveBeenCalledWith('/api/analytics/ref-summary?lineAccountId=acc%201%26x')
  })

  it('refDetail() encodes refCode in the path', async () => {
    const detail = { refCode: 'a b/c', name: null, friends: [] }
    const http = mockHttp(detail)
    const result = await new EntryRoutesResource(http).refDetail('a b/c')
    expect(http.get).toHaveBeenCalledWith('/api/analytics/ref/a%20b%2Fc')
    expect(result).toEqual(detail)
  })

  it('refDetail() uses defaultAccountId', async () => {
    const http = mockHttp({ refCode: 'lp-a', name: 'LP A', friends: [] })
    await new EntryRoutesResource(http, 'acc_default').refDetail('lp-a')
    expect(http.get).toHaveBeenCalledWith('/api/analytics/ref/lp-a?lineAccountId=acc_default')
  })

  it('refDetail() explicit lineAccountId overrides default', async () => {
    const http = mockHttp({ refCode: 'lp-a', name: 'LP A', friends: [] })
    await new EntryRoutesResource(http, 'acc_default').refDetail('lp-a', { lineAccountId: 'acc_2' })
    expect(http.get).toHaveBeenCalledWith('/api/analytics/ref/lp-a?lineAccountId=acc_2')
  })
})
