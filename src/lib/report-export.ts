// One definition of what a variance export contains — title, filter context,
// columns, rows — shared by the Excel workbook (written on the server) and the
// printable PDF view (rendered in the browser). Both buttons produce the same
// report; only the container differs.

import type { LoadShortfall } from './shortfalls.js'
import type { ShippingCondition } from './table-sort.js'
import {
  formatCustomerPo,
  formatLoadNumber,
  qtyValue,
  totalUnits,
  totalValue,
} from './units.js'

export type ExportCell = string | number

export type ExportTable = {
  /** Worksheet name in Excel, section heading in the printed report. */
  name: string
  columns: string[]
  rows: ExportCell[][]
}

export type ExportDocument = {
  title: string
  /** Without an extension: the workbook adds `.xlsx`, the print view offers it as the page title. */
  fileName: string
  /** Label/value pairs describing what the numbers were filtered to. */
  meta: Array<[string, string]>
  tables: ExportTable[]
}

export type ExportView = 'material' | 'load'

/** Everything the export needs that isn't a row: the view's filters and provenance. */
export type ExportContext = {
  view: ExportView
  palletView: boolean
  query: string
  shortfallsOnly: boolean
  from: string
  to: string
  condition: ShippingCondition
  /** Uploaded file names behind the numbers, so a saved export says where it came from. */
  sources: readonly string[]
  /** Formatted in the reader's own locale, on the client, for both export paths. */
  generatedAt: string
  /** `YYYY-MM-DD`, used for the file name. */
  dateStamp: string
  /** Rows exported vs. rows available, so a filtered export admits it is filtered. */
  shown: number
  total: number
}

export type ExportDeliveryLine = {
  orderNumber: string
  customerPO: string
  plantName: string
  soldTo: string
  shipDate: string
  shippingCondition: string
  quantity: number
}

export type ExportMaterialRow = {
  material: string
  materialName: string
  inProduction: number
  finished: number
  totalOnHand: number
  requested: number
  variance: number
  casesPerPallet: number | null
  deliveries: readonly ExportDeliveryLine[]
}

// Exported quantities are the quantities on screen: `formatQty` rounds to whole
// units everywhere in the app, so a spreadsheet cell that disagreed with the row
// it came from would just look like a bug.
//
// Rounding has to match `formatNumber`, which goes through Intl and so rounds
// halves away from zero — `Math.round` would turn a -1.5 pallet variance into
// -1 where the report shows -2. `-0` is normalised to `0` for the same reason
// it is on screen: a variance of zero must never read as negative.
function roundLikeReport(value: number): number {
  if (!Number.isFinite(value)) return 0
  const rounded = Math.sign(value) * Math.round(Math.abs(value))
  return rounded === 0 ? 0 : rounded
}

function qty(cases: number, casesPerPallet: number | null, palletView: boolean): number {
  return roundLikeReport(qtyValue(cases, casesPerPallet, palletView))
}

// In pallet view the column is mixed: a material with no footprint key match
// can't be converted and stays in cases, exactly as the tables show it.
function unitLabel(casesPerPallet: number | null, palletView: boolean) {
  if (!palletView) return 'cs'
  return casesPerPallet ? 'pl' : 'cs'
}

function conditionLabel(condition: ShippingCondition) {
  return condition === 'both' ? 'Both (01 and 02)' : condition
}

function buildMeta(ctx: ExportContext): Array<[string, string]> {
  const range =
    ctx.from || ctx.to
      ? `${ctx.from || 'earliest'} to ${ctx.to || 'latest'}`
      : 'All ship dates'

  const meta: Array<[string, string]> = [
    ['Report', ctx.view === 'load' ? 'Variance by load' : 'Variance by material'],
    ['Generated', ctx.generatedAt],
    [
      'Units',
      ctx.palletView
        ? 'Pallets (materials with no footprint stay in cases)'
        : 'Cases',
    ],
    ['Ship date range', range],
    ['Shipping condition', conditionLabel(ctx.condition)],
    ['Shortfalls only', ctx.shortfallsOnly ? 'Yes' : 'No'],
    ['Search', ctx.query.trim() || 'None'],
    [
      ctx.view === 'load' ? 'Loads' : 'Materials',
      `${ctx.shown} of ${ctx.total}`,
    ],
  ]

  if (ctx.sources.length > 0) meta.push(['Source files', ctx.sources.join(', ')])
  return meta
}

export function buildMaterialExport(
  rows: readonly ExportMaterialRow[],
  ctx: ExportContext,
): ExportDocument {
  const { palletView } = ctx
  const unitColumn = palletView ? ['Unit'] : []

  const summary: ExportTable = {
    name: 'Variance by material',
    columns: [
      'Material',
      'Name',
      'In Production',
      'Finished',
      'Stock on Hand',
      'Needed for Loads',
      'Variance',
      'Cases per Pallet',
      ...unitColumn,
    ],
    rows: rows.map((row) => [
      row.material,
      row.materialName,
      qty(row.inProduction, row.casesPerPallet, palletView),
      qty(row.finished, row.casesPerPallet, palletView),
      qty(row.totalOnHand, row.casesPerPallet, palletView),
      qty(row.requested, row.casesPerPallet, palletView),
      qty(row.variance, row.casesPerPallet, palletView),
      row.casesPerPallet ?? '',
      ...(palletView ? [unitLabel(row.casesPerPallet, palletView)] : []),
    ]),
  }

  // The delivery lines behind each material — what an expanded row shows, for
  // every exported material at once.
  const detail: ExportTable = {
    name: 'Delivery lines',
    columns: [
      'Material',
      'Name',
      'Load #',
      'Customer PO',
      'Plant',
      'Sold-To',
      'Ship Date',
      'Condition',
      'Quantity',
      ...unitColumn,
    ],
    rows: rows.flatMap((row) =>
      row.deliveries.map((line) => [
        row.material,
        row.materialName,
        formatLoadNumber(line.orderNumber),
        formatCustomerPo(line.customerPO),
        line.plantName,
        line.soldTo,
        line.shipDate,
        line.shippingCondition,
        qty(line.quantity, row.casesPerPallet, palletView),
        ...(palletView ? [unitLabel(row.casesPerPallet, palletView)] : []),
      ]),
    ),
  }

  return {
    title: 'Material stock variance — by material',
    fileName: `variance-by-material-${ctx.dateStamp}`,
    meta: buildMeta(ctx),
    tables: [summary, detail],
  }
}

export function buildLoadExport(
  loads: readonly LoadShortfall[],
  ctx: ExportContext,
): ExportDocument {
  const { palletView } = ctx

  // A load's totals span several materials, so — like the stat tiles and the
  // load table — they are built up material by material rather than divided at
  // the end. Same helpers the table cells use, then rounded the same way.
  function loadTotal(
    load: LoadShortfall,
    pick: (line: LoadShortfall['lines'][number]) => number,
  ): number {
    return roundLikeReport(totalValue(totalUnits(load.lines, pick), palletView))
  }

  // A load reads in pallets unless none of its materials has a footprint at all,
  // in which case its totals fall back to cases the way `formatTotal` does.
  function loadUnit(load: LoadShortfall) {
    if (!palletView) return 'cs'
    return load.lines.some((line) => line.casesPerPallet) ? 'pl' : 'cs'
  }

  const summary: ExportTable = {
    name: 'Variance by load',
    columns: [
      'Load #',
      'Customer PO',
      'Ship Date',
      'Ship From',
      'Ship To',
      'Materials',
      'Stock Available',
      'Needed for Loads',
      'Variance',
      ...(palletView ? ['Unit'] : []),
    ],
    rows: loads.map((load) => [
      formatLoadNumber(load.orderNumber),
      formatCustomerPo(load.customerPO),
      load.shipDate,
      load.shipFrom,
      load.shipTo,
      load.materials.length,
      loadTotal(load, (line) => line.available),
      loadTotal(load, (line) => line.requested),
      loadTotal(load, (line) => line.variance),
      ...(palletView ? [loadUnit(load)] : []),
    ]),
  }

  const detail: ExportTable = {
    name: 'Load materials',
    columns: [
      'Load #',
      'Customer PO',
      'Material',
      'Name',
      'Needed',
      'Available',
      'Variance',
      'Cases per Pallet',
      ...(palletView ? ['Unit'] : []),
    ],
    rows: loads.flatMap((load) =>
      load.lines.map((line) => [
        formatLoadNumber(load.orderNumber),
        formatCustomerPo(load.customerPO),
        line.material,
        line.materialName,
        qty(line.requested, line.casesPerPallet, palletView),
        qty(line.available, line.casesPerPallet, palletView),
        qty(line.variance, line.casesPerPallet, palletView),
        line.casesPerPallet ?? '',
        ...(palletView ? [unitLabel(line.casesPerPallet, palletView)] : []),
      ]),
    ),
  }

  return {
    title: 'Material stock variance — by load',
    fileName: `variance-by-load-${ctx.dateStamp}`,
    meta: buildMeta(ctx),
    tables: [summary, detail],
  }
}
