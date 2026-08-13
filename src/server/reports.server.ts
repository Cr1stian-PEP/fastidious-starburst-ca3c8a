import { and, eq, inArray, type SQL } from 'drizzle-orm'
import * as XLSX from 'xlsx'
import { db } from '../../db/index.js'
import { reports, reportLines, materialFootprints } from '../../db/schema.js'
import footprintKey from './data/material-footprints.json'
import {
  compareMaterialNumber,
  dateSortKey,
  filterAndSortLoads,
  filterAndSortMaterials,
  filterMaterialsByDelivery,
  sortDeliveries,
  type LoadSortKey,
  type MaterialSortKey,
  type ShippingCondition,
  type SortState,
} from '../lib/table-sort.js'
import { summarizeLoads } from '../lib/shortfalls.js'
import {
  buildLoadExport,
  buildMaterialExport,
  type ExportDocument,
  type ExportView,
} from '../lib/report-export.js'

export type ReportType = 'production' | 'materials' | 'delivery'

export const REPORT_TYPES: ReportType[] = ['production', 'materials', 'delivery']

export type ParsedLine = {
  material: string
  materialName: string
  quantity: number
  orderNumber?: string
  customerPO?: string
  plantName?: string
  soldTo?: string
  loadingDate?: string
  shipDate?: string
  shippingCondition?: string
  productionDate?: string
}

function columnLetterToIndex(letters: string): number {
  let index = 0
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64)
  return index - 1
}

// Column letters refer to spreadsheet columns in each source export, matching
// how the underlying reports are laid out (e.g. delivery Material is column Q).
const REPORT_COLUMNS: Record<
  ReportType,
  {
    material: string
    name: string
    quantity: string
    /** Shipping condition: the row is kept only if its value is in `allow`. */
    condition?: { column: string; allow: readonly string[] }
    /**
     * Which columns hold the load number and the Customer PO, keyed by the
     * row's shipping condition — the same two columns mean different things
     * depending on it. A missing `orderNumber` means that condition has no
     * load number at all.
     */
    byCondition?: Record<string, { orderNumber?: string; customerPO: string }>
    plantName?: string
    soldTo?: string
    loadingDate?: string
    shipDate?: string
    /** Production only: a date that governs the block of rows beneath it. */
    date?: string
  }
> = {
  production: { material: 'D', name: 'F', quantity: 'G', date: 'B' },
  materials: { material: 'A', name: 'B', quantity: 'C' },
  delivery: {
    material: 'Q',
    name: 'R',
    quantity: 'S',
    // Both conditions are stored so the dashboard selector can switch between
    // them; anything else is still stray data and is dropped at upload.
    condition: { column: 'T', allow: ['01', '02'] },
    // The load number and the Customer PO both come out of columns K and L, and
    // which is which depends on the shipping condition: an 01 row is a customer
    // pickup with no load of its own, so L is simply its PO; an 02 row is a
    // delivery, where L is the load number and K the PO it belongs to.
    byCondition: {
      '01': { customerPO: 'L' },
      '02': { orderNumber: 'L', customerPO: 'K' },
    },
    plantName: 'W',
    soldTo: 'Y',
    loadingDate: 'AE',
    shipDate: 'AG',
  },
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function cellToNumber(value: unknown): number {
  if (typeof value === 'number') return value
  return Number(cellToString(value).replace(/[^0-9.-]/g, ''))
}

// Most exports carry date-formatted cells, which SheetJS hands back already
// rendered ("7/29/26"). Some store the same dates as bare Excel serial numbers
// with no number format, which would otherwise surface in the report as
// "46232". Convert those; anything already readable passes through untouched.
function cellToDateString(value: unknown): string {
  const text = cellToString(value)
  if (!/^[0-9]{4,6}(\.[0-9]+)?$/.test(text)) return text

  const serial = Number(text)
  // Roughly 1954-2119 — wide enough for any real loading/ship date, narrow
  // enough that genuine non-date numbers are left alone.
  if (serial < 20000 || serial > 80000) return text

  // Excel's 1900 date system counts days from 1899-12-30; that offset absorbs
  // its fictional 1900-02-29, and every serial in the range above is well past
  // it, so the plain day offset is exact.
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000)
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${String(date.getUTCFullYear()).slice(-2)}`
}

export function parseReportFile(fileBuffer: Buffer, type: ReportType): ParsedLine[] {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  })

  const columns = REPORT_COLUMNS[type]
  const materialIdx = columnLetterToIndex(columns.material)
  const nameIdx = columnLetterToIndex(columns.name)
  const quantityIdx = columnLetterToIndex(columns.quantity)
  const conditionIdx = columns.condition ? columnLetterToIndex(columns.condition.column) : null
  // Load number / Customer PO columns resolved per shipping condition, so the
  // row loop only has to look up the condition it just read.
  const byCondition = columns.byCondition
    ? new Map(
        Object.entries(columns.byCondition).map(([value, spec]) => [
          value,
          {
            orderNumber: spec.orderNumber ? columnLetterToIndex(spec.orderNumber) : null,
            customerPO: columnLetterToIndex(spec.customerPO),
          },
        ]),
      )
    : null
  const plantNameIdx = columns.plantName ? columnLetterToIndex(columns.plantName) : null
  const soldToIdx = columns.soldTo ? columnLetterToIndex(columns.soldTo) : null
  const loadingDateIdx = columns.loadingDate ? columnLetterToIndex(columns.loadingDate) : null
  const shipDateIdx = columns.shipDate ? columnLetterToIndex(columns.shipDate) : null
  const dateIdx = columns.date ? columnLetterToIndex(columns.date) : null

  const result: ParsedLine[] = []
  // The production schedule prints its date once at the top of a block and
  // leaves the cells beneath it blank, so the date has to carry downward. That
  // heading row usually has no material number, which means the date must be
  // read *before* the material guard skips the row.
  let lastDate = ''

  for (const row of rows) {
    if (dateIdx !== null) {
      const cell = cellToDateString(row[dateIdx])
      if (cell) lastDate = cell
    }

    const material = cellToString(row[materialIdx])
    if (!/^[0-9]+$/.test(material)) continue // skips header row and blanks

    let shippingCondition: string | undefined
    if (columns.condition && conditionIdx !== null) {
      shippingCondition = cellToString(row[conditionIdx])
      if (!columns.condition.allow.includes(shippingCondition)) continue
    }

    const quantity = cellToNumber(row[quantityIdx])
    if (Number.isNaN(quantity)) continue

    // An 01 row has no load number, so it stays an empty string rather than
    // borrowing a column that means something else on that row.
    const poColumns = byCondition
      ? byCondition.get(shippingCondition ?? '') ?? { orderNumber: null, customerPO: null }
      : null

    result.push({
      material,
      materialName: cellToString(row[nameIdx]),
      quantity,
      orderNumber: poColumns
        ? poColumns.orderNumber !== null
          ? cellToString(row[poColumns.orderNumber])
          : ''
        : undefined,
      customerPO: poColumns
        ? poColumns.customerPO !== null
          ? cellToString(row[poColumns.customerPO])
          : ''
        : undefined,
      plantName: plantNameIdx !== null ? cellToString(row[plantNameIdx]) : undefined,
      soldTo: soldToIdx !== null ? cellToString(row[soldToIdx]) : undefined,
      loadingDate: loadingDateIdx !== null ? cellToDateString(row[loadingDateIdx]) : undefined,
      shipDate: shipDateIdx !== null ? cellToDateString(row[shipDateIdx]) : undefined,
      shippingCondition,
      // Rows above the first date heading get nothing rather than a guess.
      productionDate: dateIdx !== null ? lastDate : undefined,
    })
  }

  return result
}

/**
 * Deletes the reports matching `where` and their lines. The one place report
 * rows are removed, so the lines always go with them — used by an upload
 * replacing a slot, by Clear, and by the session purge.
 */
export async function deleteReportsWhere(where: SQL | undefined): Promise<number> {
  // Drizzle types a composed condition as possibly undefined, which as a `where`
  // would quietly mean every report in the database — including other people's.
  if (!where) throw new Error('deleteReportsWhere requires a condition')

  const existing = await db.select({ id: reports.id }).from(reports).where(where)
  if (existing.length === 0) return 0

  const ids = existing.map((report) => report.id)
  await db.delete(reportLines).where(inArray(reportLines.reportId, ids))
  await db.delete(reports).where(inArray(reports.id, ids))
  return existing.length
}

/** Every report a session owns, of one type or of all three. */
function ownedBy(sessionId: string, type?: ReportType) {
  return type
    ? and(eq(reports.sessionId, sessionId), eq(reports.type, type))
    : eq(reports.sessionId, sessionId)
}

export async function saveReport(
  sessionId: string,
  type: ReportType,
  label: string,
  lines: ParsedLine[],
) {
  // An upload replaces whatever this session had in the slot — and only this
  // session's, so a second person uploading their own production export doesn't
  // pull the report out from under the first.
  await deleteReportsWhere(ownedBy(sessionId, type))

  const [report] = await db.insert(reports).values({ sessionId, type, label }).returning()

  if (lines.length > 0) {
    await db.insert(reportLines).values(
      lines.map((line) => ({
        reportId: report.id,
        material: line.material,
        materialName: line.materialName,
        quantity: line.quantity,
        orderNumber: line.orderNumber,
        customerPo: line.customerPO,
        plantName: line.plantName,
        soldTo: line.soldTo,
        loadingDate: line.loadingDate,
        shipDate: line.shipDate,
        shippingCondition: line.shippingCondition,
        productionDate: line.productionDate,
      })),
    )
  }

  return report
}

export async function getAllReports(sessionId: string) {
  const allReports = await db.select().from(reports).where(ownedBy(sessionId))
  if (allReports.length === 0) return []

  const allLines = await db
    .select()
    .from(reportLines)
    .where(inArray(reportLines.reportId, allReports.map((report) => report.id)))

  return allReports.map((report) => ({
    ...report,
    lines: allLines.filter((line) => line.reportId === report.id),
  }))
}

export type StoredReport = Awaited<ReturnType<typeof getAllReports>>[number]

// Load numbers are decided at upload time, so a delivery report stored before
// the K/L mapping still holds column P in `order_number` — a zero-padded
// freight order, and one that sits on rows the parser now leaves blank. Neither
// is producible today, so either one means what is on screen came out of the
// old mapping and the export has to be re-uploaded to pick up the new one.
export function deliveryNeedsReupload(stored: readonly StoredReport[]) {
  const delivery = stored.find((report) => report.type === 'delivery')
  if (!delivery) return false

  return delivery.lines.some((line) => {
    const orderNumber = line.orderNumber?.trim()
    if (!orderNumber) return false
    // A condition-01 pickup never carries a load number now. (A line stored
    // before the condition column existed reads as 02, as it does everywhere.)
    if ((line.shippingCondition?.trim() || '02') === '01') return true
    // Column L is a plain 10-digit value; column P was padded out to 20.
    return orderNumber.length > 10
  })
}

export async function clearReport(sessionId: string, type: ReportType) {
  return { cleared: await deleteReportsWhere(ownedBy(sessionId, type)) }
}

export const BASELINE_FOOTPRINTS = footprintKey as Record<string, number>

export type FootprintSource = 'key' | 'override' | 'added'

export type FootprintRow = {
  material: string
  materialName: string
  casesPerPallet: number | null
  keyValue: number | null
  source: FootprintSource
}

// The generated key file is the baseline; rows in material_footprints override
// it. Returns the effective cases-per-pallet for every material.
export async function resolveFootprints(): Promise<Record<string, number>> {
  const overrides = await db.select().from(materialFootprints)
  const merged: Record<string, number> = { ...BASELINE_FOOTPRINTS }
  for (const row of overrides) merged[row.material] = row.casesPerPallet
  return merged
}

// Every material the app knows about: from the footprint key, from user
// overrides, and from this session's uploaded reports (so a material with no
// footprint yet still shows up and can be given one). The key and the overrides
// are shared reference data; only the uploads are session-scoped.
export async function listFootprints(sessionId: string): Promise<FootprintRow[]> {
  const [overrides, lines] = await Promise.all([
    db.select().from(materialFootprints),
    db
      .selectDistinct({ material: reportLines.material, materialName: reportLines.materialName })
      .from(reportLines)
      .innerJoin(reports, eq(reportLines.reportId, reports.id))
      .where(ownedBy(sessionId)),
  ])

  const overrideMap = new Map(overrides.map((o) => [o.material, o.casesPerPallet]))

  const names = new Map<string, string>()
  for (const line of lines) {
    if (line.materialName && !names.has(line.material)) names.set(line.material, line.materialName)
  }

  const allMaterials = new Set([
    ...Object.keys(BASELINE_FOOTPRINTS),
    ...overrideMap.keys(),
    ...names.keys(),
  ])

  const rows: FootprintRow[] = []
  for (const material of allMaterials) {
    const keyValue = BASELINE_FOOTPRINTS[material] ?? null
    const override = overrideMap.get(material)
    rows.push({
      material,
      materialName: names.get(material) ?? '',
      casesPerPallet: override ?? keyValue,
      keyValue,
      source: override === undefined ? 'key' : keyValue === null ? 'added' : 'override',
    })
  }

  return rows.sort((a, b) => compareMaterialNumber(a.material, b.material))
}

export async function upsertFootprint(material: string, casesPerPallet: number) {
  await db
    .insert(materialFootprints)
    .values({ material, casesPerPallet })
    .onConflictDoUpdate({
      target: materialFootprints.material,
      set: { casesPerPallet, updatedAt: new Date() },
    })
  return { material, casesPerPallet }
}

// Drops the user override so the material falls back to the generated key file
// (or to having no footprint at all, if the key never covered it).
export async function deleteFootprintOverride(material: string) {
  await db.delete(materialFootprints).where(eq(materialFootprints.material, material))
  return { material, keyValue: BASELINE_FOOTPRINTS[material] ?? null }
}

export type DeliveryDetail = {
  orderNumber: string
  customerPO: string
  plantName: string
  soldTo: string
  loadingDate: string
  shipDate: string
  /** Column T: '01' or '02'. Lines stored before this was captured read as '02'. */
  shippingCondition: string
  quantity: number
}

/** One date block's contribution to a material's scheduled production. */
export type ProductionDetail = {
  date: string
  quantity: number
}

export type MaterialRow = {
  material: string
  materialName: string
  inProduction: number
  finished: number
  totalOnHand: number
  requested: number
  variance: number
  casesPerPallet: number | null
  deliveries: DeliveryDetail[]
  production: ProductionDetail[]
}

export function computeMaterialSummary(
  reportsWithLines: Awaited<ReturnType<typeof getAllReports>>,
  footprints: Record<string, number> = BASELINE_FOOTPRINTS,
): MaterialRow[] {
  const productionLines = reportsWithLines.find((r) => r.type === 'production')?.lines ?? []
  const materialsLines = reportsWithLines.find((r) => r.type === 'materials')?.lines ?? []
  const deliveryLines = reportsWithLines.find((r) => r.type === 'delivery')?.lines ?? []

  const names = new Map<string, string>()
  const inProduction = new Map<string, number>()
  const finished = new Map<string, number>()
  const requested = new Map<string, number>()
  const deliveries = new Map<string, DeliveryDetail[]>()
  // Material -> production date -> quantity, so a material scheduled twice on
  // the same day reads as one entry.
  const production = new Map<string, Map<string, number>>()

  // Name precedence: materials > production > delivery, per the materials report
  // being the canonical source for material names.
  for (const line of productionLines) {
    inProduction.set(line.material, (inProduction.get(line.material) ?? 0) + line.quantity)
    if (!names.has(line.material) && line.materialName) names.set(line.material, line.materialName)

    const byDate = production.get(line.material) ?? new Map<string, number>()
    const date = line.productionDate ?? ''
    byDate.set(date, (byDate.get(date) ?? 0) + line.quantity)
    production.set(line.material, byDate)
  }
  for (const line of materialsLines) {
    finished.set(line.material, (finished.get(line.material) ?? 0) + line.quantity)
    if (line.materialName) names.set(line.material, line.materialName)
  }
  for (const line of deliveryLines) {
    requested.set(line.material, (requested.get(line.material) ?? 0) + line.quantity)
    if (!names.has(line.material) && line.materialName) names.set(line.material, line.materialName)

    const list = deliveries.get(line.material) ?? []
    list.push({
      orderNumber: line.orderNumber ?? '',
      customerPO: line.customerPo ?? '',
      plantName: line.plantName ?? '',
      soldTo: line.soldTo ?? '',
      loadingDate: line.loadingDate ?? '',
      shipDate: line.shipDate ?? '',
      // An upload from before the condition was stored defaults to '02', which
      // is what the app showed at the time, so old data doesn't vanish.
      shippingCondition: line.shippingCondition || '02',
      quantity: line.quantity,
    })
    deliveries.set(line.material, list)
  }

  const materials = new Set([...inProduction.keys(), ...finished.keys(), ...requested.keys()])
  const rows: MaterialRow[] = []

  for (const material of materials) {
    const inProductionQty = inProduction.get(material) ?? 0
    const finishedQty = finished.get(material) ?? 0
    const requestedQty = requested.get(material) ?? 0
    const totalOnHand = inProductionQty + finishedQty

    rows.push({
      material,
      materialName: names.get(material) ?? material,
      inProduction: inProductionQty,
      finished: finishedQty,
      totalOnHand,
      requested: requestedQty,
      variance: totalOnHand - requestedQty,
      casesPerPallet: footprints[material] ?? null,
      // Oldest ship date first; the dashboard can re-sort from any column.
      deliveries: sortDeliveries(deliveries.get(material) ?? [], {
        key: 'shipDate',
        dir: 'asc',
      }),
      production: [...(production.get(material)?.entries() ?? [])]
        .map(([date, quantity]) => ({ date, quantity }))
        .sort((a, b) => {
          const ka = dateSortKey(a.date)
          const kb = dateSortKey(b.date)
          if (ka === kb) return 0
          // Undated rows sit last, the way the tables treat blank dates.
          if (!Number.isFinite(ka)) return 1
          if (!Number.isFinite(kb)) return -1
          return ka - kb
        }),
    })
  }

  // Ordered by material number, matching how these reports are normally read.
  return rows.sort((a, b) => compareMaterialNumber(a.material, b.material))
}

export type ProductionScheduleLine = {
  material: string
  materialName: string
  quantity: number
  date: string
  /** Effective footprint, so the schedule page can offer Pallet View too. */
  casesPerPallet: number | null
}

// A straight read of the uploaded production schedule, in the order the plant
// works it: earliest date first, materials in number order within a date.
export async function listProductionSchedule(sessionId: string): Promise<ProductionScheduleLine[]> {
  const [report] = await db.select().from(reports).where(ownedBy(sessionId, 'production'))
  if (!report) return []

  const [lines, footprints] = await Promise.all([
    db.select().from(reportLines).where(eq(reportLines.reportId, report.id)),
    resolveFootprints(),
  ])

  return lines
    .map((line) => ({
      material: line.material,
      materialName: line.materialName,
      quantity: line.quantity,
      date: line.productionDate ?? '',
      casesPerPallet: footprints[line.material] ?? null,
    }))
    .sort((a, b) => {
      const ka = dateSortKey(a.date)
      const kb = dateSortKey(b.date)
      if (ka !== kb) {
        // Undated rows last in either case, so they don't lead the schedule.
        if (!Number.isFinite(ka)) return 1
        if (!Number.isFinite(kb)) return -1
        return ka - kb
      }
      return compareMaterialNumber(a.material, b.material)
    })
}

/** Everything the dashboard's view controls decide, so an export is exactly the view. */
export type VarianceExportRequest = {
  view: ExportView
  palletView: boolean
  query: string
  shortfallsOnly: boolean
  /** By-material view only: keep just the materials some load asks for. */
  deliveriesOnly: boolean
  /** By-material view only: keep just the materials the schedule is producing. */
  productionOnly: boolean
  /** By-load view only: allocate finished stock alone, ignoring the schedule. */
  onHandOnly: boolean
  from: string
  to: string
  condition: ShippingCondition
  /** Ship-from site (column W) the view is narrowed to; blank is every site. */
  site: string
  materialSort: SortState<MaterialSortKey>
  loadSort: SortState<LoadSortKey>
  /** Formatted on the client, so the report is stamped in the reader's own time zone. */
  generatedAt: string
  dateStamp: string
}

// Excel column widths are the one thing the shared document can't carry, since
// it has no idea how wide a character is. Size each column to its widest cell.
function columnWidths(rows: readonly (string | number)[][]) {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      const length = String(cell ?? '').length
      if (length > (widths[i] ?? 0)) widths[i] = length
    })
  }
  return widths.map((w) => ({ wch: Math.min(Math.max(w + 2, 10), 48) }))
}

// Excel rejects : \ / ? * [ ] in a sheet name and truncates past 31 characters.
function sheetName(name: string) {
  return name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31)
}

export function buildWorkbookBase64(doc: ExportDocument): string {
  const workbook = XLSX.utils.book_new()

  // The filter context gets a sheet of its own rather than a banner above each
  // table, so every data sheet starts at row 1 and sorts and filters in Excel
  // without anyone having to delete a header block first.
  const info: (string | number)[][] = [[doc.title], [], ...doc.meta.map(([k, v]) => [k, v])]
  const infoSheet = XLSX.utils.aoa_to_sheet(info)
  infoSheet['!cols'] = columnWidths(info)
  XLSX.utils.book_append_sheet(workbook, infoSheet, 'Report info')

  for (const table of doc.tables) {
    const aoa: (string | number)[][] = [table.columns, ...table.rows]
    const sheet = XLSX.utils.aoa_to_sheet(aoa)
    sheet['!cols'] = columnWidths(aoa)
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName(table.name))
  }

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  return Buffer.from(buffer).toString('base64')
}

/**
 * The variance report as a workbook. It recomputes from the same pure helpers
 * the dashboard uses — the same filter, the same sort, the same allocation —
 * rather than trusting rows sent up from the browser, so the export can't drift
 * from the report and a stale tab can't write nonsense into a file.
 */
export async function buildVarianceExport(sessionId: string, request: VarianceExportRequest) {
  const [reportsWithLines, footprints] = await Promise.all([
    getAllReports(sessionId),
    resolveFootprints(),
  ])

  const summary = computeMaterialSummary(reportsWithLines, footprints)
  const materials = filterMaterialsByDelivery(summary, {
    from: request.from,
    to: request.to,
    condition: request.condition,
    site: request.site,
  })

  const context = {
    view: request.view,
    palletView: request.palletView,
    query: request.query,
    shortfallsOnly: request.shortfallsOnly,
    deliveriesOnly: request.deliveriesOnly,
    productionOnly: request.productionOnly,
    onHandOnly: request.onHandOnly,
    from: request.from,
    to: request.to,
    condition: request.condition,
    site: request.site,
    sources: reportsWithLines.map((r) => r.label),
    generatedAt: request.generatedAt,
    dateStamp: request.dateStamp,
  }

  let doc: ExportDocument
  if (request.view === 'load') {
    // The on-hand-only toggle is part of the allocation, not of the filter, so
    // the export has to run the same pass the screen did.
    const loads = summarizeLoads(materials, { includeProduction: !request.onHandOnly })
    const visible = filterAndSortLoads(loads, {
      query: request.query,
      shortfallsOnly: request.shortfallsOnly,
      sort: request.loadSort,
    })
    doc = buildLoadExport(visible, { ...context, shown: visible.length, total: loads.length })
  } else {
    const visible = filterAndSortMaterials(materials, {
      query: request.query,
      shortfallsOnly: request.shortfallsOnly,
      deliveriesOnly: request.deliveriesOnly,
      productionOnly: request.productionOnly,
      sort: request.materialSort,
    })
    doc = buildMaterialExport(visible, {
      ...context,
      shown: visible.length,
      total: materials.length,
    })
  }

  return { fileName: `${doc.fileName}.xlsx`, base64: buildWorkbookBase64(doc) }
}
