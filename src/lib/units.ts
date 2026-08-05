// Case <-> pallet presentation, shared by the dashboard's stat tiles and its
// tables so a single Pallet View toggle can drive both.

export type UnitRow = { casesPerPallet: number | null }

export function formatNumber(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// One material's quantity. Materials with no footprint key match cannot be
// converted, so they stay in cases and say so.
export function formatQty(
  cases: number,
  casesPerPallet: number | null,
  palletView: boolean,
) {
  if (!palletView) return formatNumber(cases)
  if (!casesPerPallet) return `${formatNumber(cases)} cs`
  return `${formatNumber(cases / casesPerPallet)} pl`
}

export type UnitTotal = {
  cases: number
  /** Pallets, converted per material — cases-per-pallet differs by item, so a total can only be built up row by row. */
  pallets: number
  /** Cases left in cases because their material has no footprint. */
  unkeyedCases: number
}

export function totalUnits<T extends UnitRow>(
  rows: readonly T[],
  pick: (row: T) => number,
): UnitTotal {
  let cases = 0
  let pallets = 0
  let unkeyedCases = 0

  for (const row of rows) {
    const qty = pick(row)
    cases += qty
    if (row.casesPerPallet) pallets += qty / row.casesPerPallet
    else unkeyedCases += qty
  }

  return { cases, pallets, unkeyedCases }
}

// The headline figure for a stat tile. In pallet view a total made up entirely
// of unkeyed materials has no pallet figure to show, so it falls back to cases
// rather than reading as zero.
export function formatTotal(total: UnitTotal, palletView: boolean) {
  if (!palletView) return formatNumber(total.cases)
  if (total.pallets === 0 && total.unkeyedCases > 0) {
    return `${formatNumber(total.unkeyedCases)} cs`
  }
  return `${formatNumber(total.pallets)} pl`
}
