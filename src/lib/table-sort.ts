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
  | 'plantName'
  | 'soldTo'
  | 'loadingDate'
  | 'shipDate'
  | 'quantity'

// The fields these helpers actually read. Declared structurally rather than
// imported because reports.server.ts is server-only.
export type MaterialSortRow = {
  material: string
  materialName: string
  totalOnHand: number
  requested: number
  variance: number
}

export type DeliverySortRow = {
  orderNumber: string
  plantName: string
  soldTo: string
  loadingDate: string
  shipDate: string
  quantity: number
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

export function filterAndSortMaterials<T extends MaterialSortRow>(
  rows: readonly T[],
  options: { query: string; shortfallsOnly: boolean; sort: SortState<MaterialSortKey> },
): T[] {
  const { query, shortfallsOnly, sort } = options
  const q = query.trim().toLowerCase()

  let filtered = shortfallsOnly ? rows.filter((m) => m.variance < 0) : rows
  if (q) {
    filtered = filtered.filter(
      (m) =>
        m.material.toLowerCase().includes(q) || m.materialName.toLowerCase().includes(q),
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

export type FootprintSortKey = 'material' | 'materialName' | 'casesPerPallet' | 'source'

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
