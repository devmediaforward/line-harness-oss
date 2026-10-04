import type { HttpClient } from '../http.js'
import type {
  ApiResponse,
  EntryRoute,
  EntryRouteFunnel,
  InflowParams,
  InflowSummary,
  InflowRefDetail,
} from '../types.js'

export class EntryRoutesResource {
  constructor(
    private readonly http: HttpClient,
    private readonly defaultAccountId?: string,
  ) {}

  async list(): Promise<EntryRoute[]> {
    const res = await this.http.get<ApiResponse<EntryRoute[]>>('/api/entry-routes')
    return res.data
  }

  async funnel(id: string): Promise<EntryRouteFunnel> {
    const res = await this.http.get<ApiResponse<EntryRouteFunnel>>(
      `/api/entry-routes/${encodeURIComponent(id)}/funnel`,
    )
    return res.data
  }

  async summary(params?: InflowParams): Promise<InflowSummary> {
    const path = `/api/analytics/ref-summary${this.accountQuery(params)}`
    const res = await this.http.get<ApiResponse<InflowSummary>>(path)
    return res.data
  }

  async refDetail(refCode: string, params?: InflowParams): Promise<InflowRefDetail> {
    const path = `/api/analytics/ref/${encodeURIComponent(refCode)}${this.accountQuery(params)}`
    const res = await this.http.get<ApiResponse<InflowRefDetail>>(path)
    return res.data
  }

  private accountQuery(params?: InflowParams): string {
    const accountId = params?.lineAccountId ?? this.defaultAccountId
    return accountId ? `?lineAccountId=${encodeURIComponent(accountId)}` : ''
  }
}
