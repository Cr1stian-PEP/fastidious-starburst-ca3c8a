import { eq } from 'drizzle-orm'
import * as XLSX from 'xlsx'
import { db } from '../../db/index.js'
import { reports, reportLines, materialFootprints } from '../../db/schema.js'
import footprintKey from './data/material-footprints.json'
import { compareMaterialNumber, dateSortKey, sortDeliveries } from '../lib/table-sort.js'

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
    orderNumber?: string
    /** Candidate columns for the Customer PO, tried in order; first non-empty wins. */
    customerPO?: readonly string[]
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
    // Column P is the freight order — the load number. It is blank on a good
    // share of rows (every condition-02 row and some condition-01 ones), which
    // is why a load is identified by its Customer PO when P is empty.
    orderNumber: 'P',
    // The PO sits in K on condition-02 rows and in L on condition-01 rows, and
    // the export leaves the other one blank, so the first non-empty of the two
    // is the Customer PO. (K is headed "Customer PO"; L is headed "Order
    // Number" but carries the 43… PO on those rows.)
    customerPO: ['K', 'L'],
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
  const orderNumberIdx = columns.orderNumber ? columnLetterToIndex(columns.orderNumber) : null
  const customerPOIdxs = columns.customerPO?.map(columnLetterToIndex) ?? null
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

    result.push({
      material,
      materialName: cellToString(row[nameIdx]),
      quantity,
      orderNumber: orderNumberIdx !== null ? cellToString(row[orderNumberIdx]) : undefined,
      customerPO: customerPOIdxs
        ? customerPOIdxs.map((i) => cellToString(row[i])).find(Boolean) ?? ''
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

export async function saveReport(type: ReportType, label: string, lines: ParsedLine[]) {
  const existing = await db.select().from(reports).where(eq(reports.type, type))
  for (const report of existing) {
    await db.delete(reportLines).where(eq(reportLines.reportId, report.id))
    await db.delete(reports).where(eq(reports.id, report.id))
  }

  const [report] = await db.insert(reports).values({ type, label }).returning()

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

export async function getAllReports() {
  const allReports = await db.select().from(reports)
  const allLines = await db.select().from(reportLines)

  return allReports.map((report) => ({
    ...report,
    lines: allLines.filter((line) => line.reportId === report.id),
  }))
}

export async function clearReport(type: ReportType) {
  const existing = await db.select().from(reports).where(eq(reports.type, type))
  for (const report of existing) {
    await db.delete(reportLines).where(eq(reportLines.reportId, report.id))
    await db.delete(reports).where(eq(reports.id, report.id))
  }
  return { cleared: existing.length }
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
// overrides, and from the uploaded reports (so a material with no footprint yet
// still shows up and can be given one).
export async function listFootprints(): Promise<FootprintRow[]> {
  const [overrides, lines] = await Promise.all([
    db.select().from(materialFootprints),
    db.selectDistinct({ material: reportLines.material, materialName: reportLines.materialName }).from(reportLines),
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
}

// A straight read of the uploaded production schedule, in the order the plant
// works it: earliest date first, materials in number order within a date.
export async function listProductionSchedule(): Promise<ProductionScheduleLine[]> {
  const [report] = await db.select().from(reports).where(eq(reports.type, 'production'))
  if (!report) return []

  const lines = await db.select().from(reportLines).where(eq(reportLines.reportId, report.id))

  return lines
    .map((line) => ({
      material: line.material,
      materialName: line.materialName,
      quantity: line.quantity,
      date: line.productionDate ?? '',
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
