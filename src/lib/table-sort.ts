// Pure sorting/filtering logic behind the Excel-style table controls on the
// dashboard. Kept out of the route file so it can be exercised on its own.

export type SortDir = 'asc' | 'desc'
export type SortState<K extends string> = { key: K; dir: SortDir }

export type MaterialSortKey =
  | 'material'
  | 'materialName'
  | 'totalOnHand'
  | 'requested'
  | 'variance'

export type DeliverySortKey =
  | 'orderNumber'
  | 'customerPO'
  | 'plantName'
  | 'soldTo'
  | 'loadingDate'
  | 'shipDate'
  | 'quantity'

// Loads mirror materials: same table, same controls, one row per outbound load.
export type LoadSortKey =
  | 'orderNumber'
  | 'customerPO'
  | 'shipDate'
  | 'materialCount'
  | 'totalOnHand'
  | 'fromProduction'
  | 'requested'
  | 'variance'

/**
 * The delivery-line fields the material search reaches into. They identify a
 * load, not a material, which is exactly why they are matched here: it is what
 * lets a load number typed into the material table show the materials on that
 * load, mirroring the load table reaching into its materials.
 */
export type MaterialDeliveryRow = {
  orderNumber?: string
  customerPO?: string
  plantName?: string
  soldTo?: string
}

// The fields these helpers actually read. Declared structurally rather than
// imported because reports.server.ts is server-only.
export type MaterialSortRow = {
  material: string
  materialName: string
  totalOnHand: number
  /** Scheduled production — what "being produced" means to the filter below. */
  inProduction: number
  requested: number
  variance: number
  /**
   * The material's delivery lines, as the demand filter left them. The count is
   * what "has delivery lines" means in the current view; the load identifiers on
   * them are what the search matches.
   */
  deliveries: readonly MaterialDeliveryRow[]
}

export type DeliverySortRow = {
  orderNumber: string
  customerPO: string
  plantName: string
  soldTo: string
  loadingDate: string
  shipDate: string
  quantity: number
}

export type LoadSortRow = {
  orderNumber: string
  customerPO: string
  shipDate: string
  shipFrom?: string
  shipTo?: string
  requested: number
  totalOnHand: number
  /** How much of what the load is allocated has still to be produced. */
  fromProduction?: number
  variance: number
  materials: readonly string[]
  lines: ReadonlyArray<{ material: string; materialName: string }>
}

// Material numbers are digit strings, so a plain text sort puts "1000" before
// "999". Compare them as numbers, falling back to text for anything unexpected
// or for equal numbers that differ only by leading zeros.
export function compareMaterialNumber(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return a.localeCompare(b)
}

// Dates arrive as "m/d/yy" text, which sorts wrong as a string ("10/1/26" would
// come before "7/29/26"), so compare on the parsed day instead.
export function dateSortKey(text: string): number {
  const match = text.match(/^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2,4})$/)
  if (!match) return Number.POSITIVE_INFINITY
  const [, month, day, rawYear] = match
  const year = rawYear.length <= 2 ? 2000 + Number(rawYear) : Number(rawYear)
  return Date.UTC(year, Number(month) - 1, Number(day))
}

// Clicking a new column sorts it ascending; clicking the active column flips it.
export function nextSort<K extends string>(state: SortState<K>, key: K): SortState<K> {
  if (state.key !== key) return { key, dir: 'asc' }
  return { key, dir: state.dir === 'asc' ? 'desc' : 'asc' }
}

/**
 * Does any field hold what was typed? Used both by the table filters and by the
 * expanded panels, so a row that survived the search can point at the line that
 * kept it.
 */
export function matchesQuery(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return fields.some((field) => (field ?? '').toLowerCase().includes(q))
}

export function filterAndSortMaterials<T extends MaterialSortRow>(
  rows: readonly T[],
  options: {
    query: string
    shortfallsOnly: boolean
    /**
     * Keep only materials some load actually asks for. The lines are the ones
     * the demand filter left, so a material whose only lines fall outside the
     * ship-date window, condition or site drops with them.
     */
    deliveriesOnly?: boolean
    /**
     * Keep only materials the production schedule is making — the stock that is
     * coming rather than the stock that is already there.
     */
    productionOnly?: boolean
    sort: SortState<MaterialSortKey>
  },
): T[] {
  const { query, shortfallsOnly, deliveriesOnly, productionOnly, sort } = options
  const q = query.trim().toLowerCase()

  let filtered = shortfallsOnly ? rows.filter((m) => m.variance < 0) : rows
  if (deliveriesOnly) filtered = filtered.filter((m) => m.deliveries.length > 0)
  if (productionOnly) filtered = filtered.filter((m) => m.inProduction > 0)
  if (q) {
    filtered = filtered.filter(
      (m) =>
        m.material.toLowerCase().includes(q) ||
        m.materialName.toLowerCase().includes(q) ||
        // A load number, PO, plant or ship-to belongs to the load rather than to
        // the material, so matching them turns the material table into the
        // answer to "what is on this load" instead of an empty result.
        m.deliveries.some((d) =>
          matchesQuery(q, d.orderNumber, d.customerPO, d.plantName, d.soldTo),
        ),
    )
  }

  const dir = sort.dir === 'asc' ? 1 : -1
  return [...filtered].sort((a, b) => {
    if (sort.key === 'material') return dir * compareMaterialNumber(a.material, b.material)
    if (sort.key === 'materialName') return dir * a.materialName.localeCompare(b.materialName)
    return dir * (a[sort.key] - b[sort.key])
  })
}

export function sortDeliveries<T extends DeliverySortRow>(
  deliveries: readonly T[],
  sort: SortState<DeliverySortKey>,
): T[] {
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...deliveries].sort((a, b) => {
    if (sort.key === 'quantity') return dir * (a.quantity - b.quantity)

    if (sort.key === 'loadingDate' || sort.key === 'shipDate') {
      const ka = dateSortKey(a[sort.key])
      const kb = dateSortKey(b[sort.key])
      if (ka === kb) return 0
      // Blank/unparseable dates stay at the bottom in both directions, the way
      // Excel keeps empty cells last.
      if (!Number.isFinite(ka)) return 1
      if (!Number.isFinite(kb)) return -1
      return dir * (ka - kb)
    }

    return dir * a[sort.key].localeCompare(b[sort.key])
  })
}

export type MaterialSuggestion = { material: string; materialName: string }

/**
 * Material suggestions for the search box: the materials whose number or name
 * contains what has been typed, best match first — an exact material number,
 * then a number the query starts, then a name it starts, then anything else that
 * contains it. Ranking matters more than it looks: typing "10" should offer
 * 10xxx before a name with "10" buried in it.
 */
export function suggestMaterials<T extends MaterialSuggestion>(
  rows: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const scored: Array<{ row: T; rank: number }> = []
  for (const row of rows) {
    const material = row.material.toLowerCase()
    const name = row.materialName.toLowerCase()

    let rank: number
    if (material === q) rank = 0
    else if (material.startsWith(q)) rank = 1
    else if (name.startsWith(q)) rank = 2
    else if (material.includes(q)) rank = 3
    else if (name.includes(q)) rank = 4
    else continue

    scored.push({ row, rank })
  }

  return scored
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      return compareMaterialNumber(a.row.material, b.row.material)
    })
    .slice(0, limit)
    .map((entry) => entry.row)
}

export type LoadSuggestion = {
  key: string
  orderNumber: string
  customerPO: string
  shipFrom?: string
  shipTo?: string
}

/**
 * Load suggestions for the search box, ranked the way `suggestMaterials` ranks
 * materials: the load number first, then the Customer PO, then the plant it
 * ships from or the party it ships to. A condition-01 pickup has no load number,
 * so its PO is the only thing that can find it.
 *
 * Loads are *not* matched on the materials they carry — a material number
 * already has a suggestion of its own, and offering the twenty loads that carry
 * it instead would bury it.
 */
export function suggestLoads<T extends LoadSuggestion>(
  rows: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const scored: Array<{ row: T; rank: number }> = []
  for (const row of rows) {
    const order = row.orderNumber.trim().toLowerCase()
    const po = row.customerPO.trim().toLowerCase()

    let rank: number
    if (order === q || po === q) rank = 0
    else if (order && order.startsWith(q)) rank = 1
    else if (po && po.startsWith(q)) rank = 2
    else if (order.includes(q) || po.includes(q)) rank = 3
    else if (matchesQuery(q, row.shipFrom, row.shipTo)) rank = 4
    else continue

    scored.push({ row, rank })
  }

  return scored
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      return a.row.key.localeCompare(b.row.key)
    })
    .slice(0, limit)
    .map((entry) => entry.row)
}

/**
 * Merge the two suggestion lists so the view you are in leads while the other
 * kind stays reachable: the current view's matches keep `lead` places, the other
 * kind fills the rest, and whichever side runs short gives its places back.
 */
export function mergeSuggestions<T>(
  primary: readonly T[],
  secondary: readonly T[],
  limit = 8,
  lead = 5,
): T[] {
  const keep = Math.min(primary.length, Math.max(lead, limit - secondary.length))
  return [...primary.slice(0, keep), ...secondary.slice(0, limit - keep)]
}

export type FootprintSortKey = 'material' | 'materialName' | 'casesPerPallet' | 'source'

// Loads carry their own per-material breakdown, so the search box can reach
// inside a load and match on a material it contains as well as on the load's
// own identifiers.
export function filterAndSortLoads<T extends LoadSortRow>(
  rows: readonly T[],
  options: { query: string; shortfallsOnly: boolean; sort: SortState<LoadSortKey> },
): T[] {
  const { query, shortfallsOnly, sort } = options
  const q = query.trim().toLowerCase()

  let filtered = shortfallsOnly ? rows.filter((l) => l.variance < 0) : rows
  if (q) {
    filtered = filtered.filter(
      (l) =>
        l.orderNumber.toLowerCase().includes(q) ||
        l.customerPO.toLowerCase().includes(q) ||
        (l.shipFrom ?? '').toLowerCase().includes(q) ||
        (l.shipTo ?? '').toLowerCase().includes(q) ||
        l.lines.some(
          (line) =>
            line.material.toLowerCase().includes(q) ||
            line.materialName.toLowerCase().includes(q),
        ),
    )
  }

  const dir = sort.dir === 'asc' ? 1 : -1
  return [...filtered].sort((a, b) => {
    if (sort.key === 'materialCount') return dir * (a.materials.length - b.materials.length)

    if (sort.key === 'shipDate') {
      const ka = dateSortKey(a.shipDate)
      const kb = dateSortKey(b.shipDate)
      if (ka === kb) return 0
      if (!Number.isFinite(ka)) return 1
      if (!Number.isFinite(kb)) return -1
      return dir * (ka - kb)
    }

    if (sort.key === 'orderNumber') {
      // Condition-01 pickups have no load number at all. Keep those together at
      // the bottom in both directions rather than letting the empty string sort
      // to the top when the direction flips.
      const a0 = a.orderNumber.trim()
      const b0 = b.orderNumber.trim()
      if (!a0 && !b0) return 0
      if (!a0) return 1
      if (!b0) return -1
      return dir * a0.localeCompare(b0)
    }

    if (sort.key === 'customerPO') {
      return dir * a.customerPO.localeCompare(b.customerPO)
    }

    // A load with nothing on the schedule behind it has no production figure at
    // all; it sorts as zero rather than as missing.
    if (sort.key === 'fromProduction') {
      return dir * ((a.fromProduction ?? 0) - (b.fromProduction ?? 0))
    }

    return dir * (a[sort.key] - b[sort.key])
  })
}

// The shipping condition the demand side is read at. '02' is the default view,
// matching what the app showed before the selector existed.
export type ShippingCondition = '01' | '02' | 'both'

// The delivery line fields the demand-side filter reads.
export type DeliveryFilterRow = {
  shipDate: string
  quantity: number
  shippingCondition?: string
  /** Site the load ships from (column W) — what the site selector matches on. */
  plantName?: string
}

/**
 * Every site (ship-from plant, column W) named anywhere in the outbound loads
 * report, in alphabetical order. Built from the unfiltered materials so choosing
 * one doesn't collapse the list to the chosen one. Blank plants are left out —
 * there is nothing to select.
 */
export function collectDeliverySites<
  T extends { deliveries: readonly { plantName?: string }[] },
>(materials: readonly T[]): string[] {
  const sites = new Set<string>()
  for (const material of materials) {
    for (const delivery of material.deliveries) {
      const site = delivery.plantName?.trim()
      if (site) sites.add(site)
    }
  }
  return [...sites].sort((a, b) => a.localeCompare(b))
}

// A ship-date range, a shipping condition and a site all narrow the demand side
// of the report: only delivery lines that survive every one of them count, so
// `requested` and `variance` are rebuilt from the survivors. Stock isn't dated,
// conditioned or sited, so it is left exactly as it was.
export function filterMaterialsByDelivery<
  T extends {
    requested: number
    variance: number
    totalOnHand: number
    deliveries: Array<DeliveryFilterRow>
  },
>(
  materials: readonly T[],
  options: { from: string; to: string; condition: ShippingCondition; site?: string },
): T[] {
  const { from, to, condition } = options
  const site = options.site?.trim() ?? ''
  if (!from && !to && condition === 'both' && !site) return materials as T[]

  // dateSortKey returns a Date.UTC value, so the date inputs parse straight
  // onto the same scale. Both ends are inclusive.
  const min = from ? Date.parse(`${from}T00:00:00Z`) : Number.NEGATIVE_INFINITY
  const max = to ? Date.parse(`${to}T00:00:00Z`) : Number.POSITIVE_INFINITY
  const rangeActive = Boolean(from || to)

  return materials.map((material) => {
    const deliveries = material.deliveries.filter((d) => {
      // Lines stored before the condition was captured read as '02', which is
      // what the app showed when they were uploaded.
      if (condition !== 'both' && (d.shippingCondition || '02') !== condition) return false
      // A line with no plant can't be shown to belong to the chosen site.
      if (site && (d.plantName?.trim() ?? '') !== site) return false
      if (!rangeActive) return true

      const key = dateSortKey(d.shipDate)
      // An undated line can't be shown to fall inside the window, so it drops.
      if (!Number.isFinite(key)) return false
      return key >= min && key <= max
    })

    const requested = deliveries.reduce((sum, d) => sum + d.quantity, 0)
    return {
      ...material,
      deliveries,
      requested,
      variance: material.totalOnHand - requested,
    } as T
  })
}

// 'missing' = no cases-per-pallet at all, so the material can't convert to
// pallets. 'edited' = the value came from a user edit rather than the key file.
export type FootprintFilter = 'all' | 'missing' | 'edited'

export type FootprintSortRow = {
  material: string
  materialName: string
  casesPerPallet: number | null
  source: string
}

export function filterAndSortFootprints<T extends FootprintSortRow>(
  rows: readonly T[],
  options: { query: string; filter: FootprintFilter; sort: SortState<FootprintSortKey> },
): T[] {
  const { query, filter, sort } = options
  const q = query.trim().toLowerCase()

  let filtered = rows
  if (filter === 'missing') filtered = filtered.filter((r) => r.casesPerPallet === null)
  if (filter === 'edited') filtered = filtered.filter((r) => r.source !== 'key')
  if (q) {
    filtered = filtered.filter(
      (r) =>
        r.material.toLowerCase().includes(q) || r.materialName.toLowerCase().includes(q),
    )
  }

  const dir = sort.dir === 'asc' ? 1 : -1
  return [...filtered].sort((a, b) => {
    if (sort.key === 'material') return dir * compareMaterialNumber(a.material, b.material)

    if (sort.key === 'casesPerPallet') {
      const ka = a.casesPerPallet
      const kb = b.casesPerPallet
      if (ka === kb) return 0
      // Materials without a footprint stay at the bottom either way, so the
      // gaps to fill in don't scatter through the list when the sort flips.
      if (ka === null) return 1
      if (kb === null) return -1
      return dir * (ka - kb)
    }

    return dir * a[sort.key].localeCompare(b[sort.key])
  })
}
