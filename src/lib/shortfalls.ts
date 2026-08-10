// Aggregation behind the "largest shortfalls" chart. The chart can group either
// by material number or by load (delivery order number).

import { dateSortKey } from './table-sort.js'

export type ShortfallDelivery = {
  orderNumber: string
  customerPO?: string
  quantity: number
  loadingDate?: string
  shipDate?: string
  /** Plant the load ships from (column W). */
  plantName?: string
  /** Party the load ships to (column Y). */
  soldTo?: string
}

export type ShortfallMaterial = {
  material: string
  materialName: string
  totalOnHand: number
  requested: number
  variance: number
  casesPerPallet?: number | null
  deliveries: readonly ShortfallDelivery[]
}

/** One material's share of a load, as the allocation settled it. */
export type LoadLine = {
  material: string
  materialName: string
  /** What this load asks for. */
  requested: number
  /** What the allocation gave it. */
  available: number
  /** `available - requested`. */
  variance: number
  casesPerPallet: number | null
}

export type LoadShortfall = {
  /**
   * What identifies this load for grouping, refs and highlighting: the load
   * number when there is one, otherwise the Customer PO. Never blank, never
   * shared between two different loads.
   */
  key: string
  /** Load number (column L on condition-02 rows). Blank on condition-01 pickups. */
  orderNumber: string
  /** Customer PO from the load's lines — the first non-empty one. */
  customerPO: string
  /**
   * Where the load ships from (column W) and where it goes (column Y). A load
   * normally agrees across its lines, but nothing in the export guarantees it,
   * so every distinct non-empty value is kept and joined rather than silently
   * dropping the ones after the first. Blank when no line carries the field.
   */
  shipFrom: string
  shipTo: string
  /** Distinct material numbers this load needs. */
  materials: string[]
  /** Per-material breakdown behind the totals below. */
  lines: LoadLine[]
  /** Total quantity the load asks for across all its lines. */
  requested: number
  /**
   * Stock this load can actually draw on: its own demand, capped by what is
   * left of each material after every earlier-shipping load has taken its
   * share. Because it is capped at what the load asks for, it reads directly
   * against `requested` — a covered load shows the two as equal.
   */
  totalOnHand: number
  /** `totalOnHand - requested` — the cases this load is short. */
  variance: number
  /** The material short the most cases on this load, used as the jump target from the chart. */
  worstMaterial: string
  /** Ship date the load was allocated on, for the chart tooltip. Blank if none of its lines carry one. */
  shipDate: string
}

type LoadEntry = {
  key: string
  orderNumber: string
  customerPO: string
  /** Distinct ship-from plants / ship-to parties seen on the load's lines. */
  shipFrom: Set<string>
  shipTo: Set<string>
  /** Material number -> quantity this load asks for. */
  demand: Map<string, number>
  requested: number
  /** Parsed ship (or loading) date, driving allocation order. */
  dateKey: number
  shipDate: string
}

// A load ships once, so if its lines disagree the earliest date is the one that
// matters. Ship date is the real commitment; loading date is the fallback for
// exports where ship date is blank.
function earliestDateKey(...texts: Array<string | undefined>): number {
  let best = Number.POSITIVE_INFINITY
  for (const text of texts) {
    if (!text) continue
    const key = dateSortKey(text)
    if (Number.isFinite(key) && key < best) best = key
  }
  return best
}

// Only condition-02 rows carry a load number (column L); a condition-01 row is
// a customer pickup with no load of its own, so its Customer PO is what
// identifies it. Keying on the load number alone would fold every 01 line into
// one "(no load #)" row and hide every PO in it. Returns '' for a line carrying
// neither, which the grouper gives a key of its own.
export function deliveryLoadKey(delivery: ShortfallDelivery): string {
  const orderNumber = delivery.orderNumber?.trim()
  if (orderNumber) return `load:${orderNumber}`
  const customerPO = delivery.customerPO?.trim()
  if (customerPO) return `po:${customerPO}`
  return ''
}

export function groupShortfallsByLoad(
  materials: readonly ShortfallMaterial[],
): LoadShortfall[] {
  const byLoad = new Map<string, LoadEntry>()
  // Names and footprints live on the material, not the delivery line, so the
  // per-load breakdown reads them back out here.
  const meta = new Map(
    materials.map(
      (m) =>
        [m.material, { name: m.materialName, casesPerPallet: m.casesPerPallet ?? null }] as const,
    ),
  )

  let unidentified = 0

  for (const material of materials) {
    for (const delivery of material.deliveries) {
      const key = deliveryLoadKey(delivery) || `line:${unidentified}`
      if (key.startsWith('line:')) unidentified += 1
      let entry = byLoad.get(key)
      if (!entry) {
        entry = {
          key,
          orderNumber: delivery.orderNumber?.trim() ?? '',
          customerPO: '',
          shipFrom: new Set<string>(),
          shipTo: new Set<string>(),
          demand: new Map<string, number>(),
          requested: 0,
          dateKey: Number.POSITIVE_INFINITY,
          shipDate: '',
        }
        byLoad.set(key, entry)
      }

      // Lines on one load should agree on the PO; if they don't, the first
      // non-empty one stands for the load.
      if (!entry.customerPO && delivery.customerPO) entry.customerPO = delivery.customerPO

      const plantName = delivery.plantName?.trim()
      if (plantName) entry.shipFrom.add(plantName)
      const soldTo = delivery.soldTo?.trim()
      if (soldTo) entry.shipTo.add(soldTo)

      entry.demand.set(
        material.material,
        (entry.demand.get(material.material) ?? 0) + delivery.quantity,
      )
      entry.requested += delivery.quantity

      const dateKey = earliestDateKey(delivery.shipDate, delivery.loadingDate)
      if (dateKey < entry.dateKey) {
        entry.dateKey = dateKey
        entry.shipDate = delivery.shipDate || delivery.loadingDate || ''
      }
    }
  }

  // Stock is finite and the same cases cannot cover two loads, so it is handed
  // out rather than counted once per load: walk the loads in ship-date order —
  // the load that ships first has first call on the stock — and draw each
  // material down as it is committed. What a load gets is therefore what is
  // genuinely still there for it, and undated loads sort last because they
  // cannot claim priority over a load with a date on it.
  const remaining = new Map(
    materials.map((m) => [m.material, Math.max(m.totalOnHand, 0)] as const),
  )

  const ordered = [...byLoad.values()].sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey - b.dateKey
    return a.key.localeCompare(b.key)
  })

  const loads: LoadShortfall[] = []

  for (const entry of ordered) {
    let totalOnHand = 0
    let worstMaterial = ''
    let worstShort = 0
    const lines: LoadLine[] = []

    for (const [material, demand] of entry.demand) {
      const stock = remaining.get(material) ?? 0
      const covered = Math.min(demand, stock)
      remaining.set(material, stock - covered)
      totalOnHand += covered

      lines.push({
        material,
        materialName: meta.get(material)?.name ?? material,
        requested: demand,
        available: covered,
        variance: covered - demand,
        casesPerPallet: meta.get(material)?.casesPerPallet ?? null,
      })

      const short = demand - covered
      if (short > worstShort) {
        worstShort = short
        worstMaterial = material
      }
    }

    const materialNumbers = [...entry.demand.keys()]

    loads.push({
      key: entry.key,
      orderNumber: entry.orderNumber,
      customerPO: entry.customerPO,
      shipFrom: [...entry.shipFrom].join(', '),
      shipTo: [...entry.shipTo].join(', '),
      materials: materialNumbers,
      lines,
      requested: entry.requested,
      totalOnHand,
      variance: totalOnHand - entry.requested,
      // Nothing short means no driving material; fall back to the first one so
      // a bar click still lands somewhere useful.
      worstMaterial: worstMaterial || materialNumbers[0] || '',
      shipDate: entry.shipDate,
    })
  }

  return loads
}

/**
 * Every load, in allocation order. The load table reads this directly; the
 * chart filters it down. Both go through one allocation pass so the numbers
 * can't disagree.
 */
export function summarizeLoads(materials: readonly ShortfallMaterial[]): LoadShortfall[] {
  return groupShortfallsByLoad(materials)
}

/** Worst shortfall first. Only rows that are actually short are worth charting. */
export function topShortfallLoads(
  materials: readonly ShortfallMaterial[],
  limit: number,
): LoadShortfall[] {
  return summarizeLoads(materials)
    .filter((load) => load.variance < 0)
    .sort((a, b) => a.variance - b.variance)
    .slice(0, limit)
}

export function topShortfallMaterials<T extends { requested: number; variance: number }>(
  materials: readonly T[],
  limit: number,
): T[] {
  // Only materials with actual load demand are worth charting — otherwise the
  // biggest bars are just high-stock items nobody has ordered.
  return [...materials]
    .filter((m) => m.requested > 0)
    .sort((a, b) => a.variance - b.variance)
    .slice(0, limit)
}

/**
 * The slice of the allocation that covers a given set of materials: each load
 * cut down to its lines for those materials, with its totals rebuilt from what
 * is left and loads that need none of them dropped.
 *
 * The allocation itself is **not** re-run. Which load got which cases is a
 * property of the whole book — ship-date order over the whole demand — so a
 * search must read a slice of that one answer rather than re-allocate the stock
 * as though the unsearched loads weren't competing for it.
 */
export function restrictLoadsToMaterials(
  loads: readonly LoadShortfall[],
  materials: Iterable<string>,
): LoadShortfall[] {
  const wanted = new Set(materials)
  const scoped: LoadShortfall[] = []

  for (const load of loads) {
    // Nothing to cut — keep the load exactly as the allocation left it.
    if (load.lines.every((line) => wanted.has(line.material))) {
      scoped.push(load)
      continue
    }

    const lines = load.lines.filter((line) => wanted.has(line.material))
    if (lines.length === 0) continue

    let requested = 0
    let totalOnHand = 0
    let worstMaterial = ''
    let worstShort = 0
    for (const line of lines) {
      requested += line.requested
      totalOnHand += line.available
      const short = line.requested - line.available
      if (short > worstShort) {
        worstShort = short
        worstMaterial = line.material
      }
    }

    scoped.push({
      ...load,
      materials: lines.map((line) => line.material),
      lines,
      requested,
      totalOnHand,
      variance: totalOnHand - requested,
      worstMaterial: worstMaterial || lines[0].material,
    })
  }

  return scoped
}

/**
 * How much of what a load asks for the allocation actually gave it, as a
 * percentage. A load asking for nothing is covered by definition rather than
 * dividing by zero.
 */
export function loadAllocatedPercent(load: {
  requested: number
  totalOnHand: number
}): number {
  if (load.requested <= 0) return 100
  return (load.totalOnHand / load.requested) * 100
}

/**
 * How the loads in the current view came out of the allocation: how many are
 * fully covered, how many are allocated enough of what they asked for to count,
 * and how many are genuinely short.
 *
 * The allocation caps what a load gets at what it asks for, so a load's variance
 * is never positive — "fully allocated" means a variance of zero, and the
 * threshold widens that to loads allocated at least a given **percentage** of
 * their demand. A percentage is the unit-free way to say it: cases-per-pallet
 * differs by material, so "short by 60 cases" means something different on every
 * load, while "95% allocated" reads the same whether the page is in cases or
 * pallets and whether the load is one pallet or forty.
 *
 * Loads are returned alongside the counts so the caller can total them in
 * whatever units the page is showing; a pallet total can only be built up from
 * each load's own lines.
 */
export type AllocationSummary = {
  /** Loads in the view. */
  loads: number
  /** Loads whose demand the allocation covered outright. */
  covered: number
  /** Loads short, but allocated at least the threshold percentage. */
  withinTolerance: number
  /** `covered + withinTolerance` — what the report calls fully allocated. */
  allocated: number
  /** Loads allocated less than the threshold. */
  short: number
  /** The short loads themselves, worst first. */
  shortLoads: LoadShortfall[]
  /** Demand-weighted coverage across the view, as a percentage. */
  allocatedPercent: number
}

export function summarizeAllocation(
  loads: readonly LoadShortfall[],
  minAllocatedPercent = 100,
): AllocationSummary {
  const threshold = Math.min(100, Math.max(0, minAllocatedPercent))

  let covered = 0
  let withinTolerance = 0
  let requested = 0
  let allocatedCases = 0
  const shortLoads: LoadShortfall[] = []

  for (const load of loads) {
    requested += load.requested
    allocatedCases += load.totalOnHand

    // Quantities come out of a spreadsheet and can carry a fractional tail, so a
    // load short by a millionth of a case is covered, not short.
    if (-load.variance <= 1e-9) {
      covered += 1
      continue
    }
    if (loadAllocatedPercent(load) >= threshold - 1e-9) withinTolerance += 1
    else shortLoads.push(load)
  }

  shortLoads.sort((a, b) => a.variance - b.variance)

  return {
    loads: loads.length,
    covered,
    withinTolerance,
    allocated: covered + withinTolerance,
    short: shortLoads.length,
    shortLoads,
    allocatedPercent: loadAllocatedPercent({ requested, totalOnHand: allocatedCases }),
  }
}

