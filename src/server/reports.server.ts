import { eq } from 'drizzle-orm'
import * as XLSX from 'xlsx'
import { db } from '../../db/index.js'
import { reports, reportLines, materialFootprints } from '../../db/schema.js'
import footprintKey from './data/material-footprints.json'
import { compareMaterialNumber, sortDeliveries } from '../lib/table-sort.js'

export type ReportType = 'production' | 'materials' | 'delivery'

export const REPORT_TYPES: ReportType[] = ['production', 'materials', 'delivery']

export type ParsedLine = {
  material: string
  materialName: string
  quantity: number
  orderNumber?: string
  plantName?: string
  soldTo?: string
  loadingDate?: string
  shipDate?: string
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
    condition?: { column: string; equals: string }
    orderNumber?: string
    plantName?: string
    soldTo?: string
    loadingDate?: string
    shipDate?: string
  }
> = {
  production: { material: 'D', name: 'F', quantity: 'G' },
  materials: { material: 'A', name: 'B', quantity: 'C' },
  delivery: {
    material: 'Q',
    name: 'R',
    quantity: 'S',
    condition: { column: 'T', equals: '02' },
    orderNumber: 'L',
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
  const plantNameIdx = columns.plantName ? columnLetterToIndex(columns.plantName) : null
  const soldToIdx = columns.soldTo ? columnLetterToIndex(columns.soldTo) : null
  const loadingDateIdx = columns.loadingDate ? columnLetterToIndex(columns.loadingDate) : null
  const shipDateIdx = columns.shipDate ? columnLetterToIndex(columns.shipDate) : null

  const result: ParsedLine[] = []

  for (const row of rows) {
    const material = cellToString(row[materialIdx])
    if (!/^[0-9]+$/.test(material)) continue // skips header row and blanks

    if (columns.condition && conditionIdx !== null) {
      const conditionValue = cellToString(row[conditionIdx])
      if (conditionValue !== columns.condition.equals) continue
    }

    const quantity = cellToNumber(row[quantityIdx])
    if (Number.isNaN(quantity)) continue

    result.push({
      material,
      materialName: cellToString(row[nameIdx]),
      quantity,
      orderNumber: orderNumberIdx !== null ? cellToString(row[orderNumberIdx]) : undefined,
      plantName: plantNameIdx !== null ? cellToString(row[plantNameIdx]) : undefined,
      soldTo: soldToIdx !== null ? cellToString(row[soldToIdx]) : undefined,
      loadingDate: loadingDateIdx !== null ? cellToDateString(row[loadingDateIdx]) : undefined,
      shipDate: shipDateIdx !== null ? cellToDateString(row[shipDateIdx]) : undefined,
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
        plantName: line.plantName,
        soldTo: line.soldTo,
        loadingDate: line.loadingDate,
        shipDate: line.shipDate,
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
  plantName: string
  soldTo: string
  loadingDate: string
  shipDate: string
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

  // Name precedence: materials > production > delivery, per the materials report
  // being the canonical source for material names.
  for (const line of productionLines) {
    inProduction.set(line.material, (inProduction.get(line.material) ?? 0) + line.quantity)
    if (!names.has(line.material) && line.materialName) names.set(line.material, line.materialName)
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
      plantName: line.plantName ?? '',
      soldTo: line.soldTo ?? '',
      loadingDate: line.loadingDate ?? '',
      shipDate: line.shipDate ?? '',
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
    })
  }

  // Ordered by material number, matching how these reports are normally read.
  return rows.sort((a, b) => compareMaterialNumber(a.material, b.material))
}
