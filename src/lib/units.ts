// Case <-> pallet presentation, shared by the dashboard's stat tiles and its
// tables so a single Pallet View toggle can drive both.

export type UnitRow = { casesPerPallet: number | null }

export function formatNumber(n: number) {
  // Anything that rounds to zero is zero: a pallet conversion can leave a
  // value like -1e-13 behind, and "-0" is never a quantity anyone wants to read.
  if (!Number.isFinite(n) || Math.abs(n) < 0.5) return '0'
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

// Customer POs are whole identifiers — 10 digits in the export, no padding — so
// they render exactly as they arrive. (An earlier version trimmed them to 9
// characters on the belief that the tail was filler; that truncated real POs.)
export function formatCustomerPo(customerPO: string) {
  return customerPO.trim()
}

// Load numbers are whole identifiers too. They come from the same 10-digit,
// unpadded K/L pair as the Customer PO, so — like the PO — the string renders
// exactly as the export gives it. (The old zero-stripping here existed for the
// 20-character zero-padded freight order in column P, which is no longer read;
// applied to a K/L value it would eat a real leading digit.)
export function formatLoadNumber(orderNumber: string) {
  return orderNumber.trim()
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
export function totalValue(total: UnitTotal, palletView: boolean) {
  if (!palletView) return total.cases
  if (total.pallets === 0 && total.unkeyedCases > 0) return total.unkeyedCases
  return total.pallets
}

export function formatTotal(total: UnitTotal, palletView: boolean) {
  if (!palletView) return formatNumber(total.cases)
  if (total.pallets === 0 && total.unkeyedCases > 0) {
    return `${formatNumber(total.unkeyedCases)} cs`
  }
  return `${formatNumber(total.pallets)} pl`
}

// In pallet view a total is only as complete as the footprint key: cases whose
// material has no match can't be converted, so a tile says how many are sitting
// outside the pallet figure instead of quietly dropping them. Blank when there
// is nothing left over to mention.
export function unkeyedNote(total: UnitTotal, palletView: boolean) {
  if (!palletView || total.unkeyedCases === 0 || total.pallets === 0) return ''
  return `+ ${formatNumber(total.unkeyedCases)} cs with no footprint`
}

/** One material's quantity as a number, for charting. Mirrors `formatQty`. */
export function qtyValue(cases: number, casesPerPallet: number | null, palletView: boolean) {
  if (!palletView || !casesPerPallet) return cases
  return cases / casesPerPallet
}
