// Aggregation behind the "largest shortfalls" chart. The chart can group either
// by material number or by load (delivery order number).

export type ShortfallDelivery = {
  orderNumber: string
  quantity: number
}

export type ShortfallMaterial = {
  material: string
  materialName: string
  totalOnHand: number
  requested: number
  variance: number
  deliveries: readonly ShortfallDelivery[]
}

export type LoadShortfall = {
  orderNumber: string
  /** Distinct material numbers this load needs. */
  materials: string[]
  /** Total quantity the load asks for across all its lines. */
  requested: number
  /** Stock on hand for the materials this load needs. */
  totalOnHand: number
  /**
   * How much material shortage this load is exposed to: the sum of the
   * shortfalls of the distinct materials it needs. A material that is short
   * counts against every load needing it, because the same cases cannot cover
   * two loads.
   */
  variance: number
  /** The material driving the shortfall, used as the jump target from the chart. */
  worstMaterial: string
}

export function groupShortfallsByLoad(
  materials: readonly ShortfallMaterial[],
): LoadShortfall[] {
  const byLoad = new Map<string, { materials: Set<string>; requested: number }>()

  for (const material of materials) {
    for (const delivery of material.deliveries) {
      const orderNumber = delivery.orderNumber || '(no order #)'
      const entry = byLoad.get(orderNumber) ?? { materials: new Set<string>(), requested: 0 }
      entry.materials.add(material.material)
      entry.requested += delivery.quantity
      byLoad.set(orderNumber, entry)
    }
  }

  const byMaterial = new Map(materials.map((m) => [m.material, m]))
  const loads: LoadShortfall[] = []

  for (const [orderNumber, entry] of byLoad) {
    let variance = 0
    let totalOnHand = 0
    let worstMaterial = ''
    let worstVariance = Number.POSITIVE_INFINITY

    for (const material of entry.materials) {
      const row = byMaterial.get(material)
      if (!row) continue
      totalOnHand += row.totalOnHand
      if (row.variance < 0) variance += row.variance
      if (row.variance < worstVariance) {
        worstVariance = row.variance
        worstMaterial = material
      }
    }

    loads.push({
      orderNumber,
      materials: [...entry.materials],
      requested: entry.requested,
      totalOnHand,
      variance,
      worstMaterial,
    })
  }

  return loads
}

/** Worst shortfall first. Only rows that are actually short are worth charting. */
export function topShortfallLoads(
  materials: readonly ShortfallMaterial[],
  limit: number,
): LoadShortfall[] {
  return groupShortfallsByLoad(materials)
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
