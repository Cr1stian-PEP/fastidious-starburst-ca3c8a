import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { reports, reportLines } from '../../db/schema.js'

export type ParsedLine = { category: string; amount: number }

export function parseCsv(text: string): ParsedLine[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const result: ParsedLine[] = []

  for (const line of lines) {
    const cells = line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''))
    if (cells.length < 2) continue

    const [category, rawAmount] = cells
    const amount = Number(rawAmount.replace(/[^0-9.-]/g, ''))

    if (!category || Number.isNaN(amount)) continue
    if (category.toLowerCase() === 'category') continue // skip header row

    result.push({ category, amount })
  }

  return result
}

export async function saveReport(slot: number, label: string, lines: ParsedLine[]) {
  const existing = await db.select().from(reports).where(eq(reports.slot, slot))
  for (const report of existing) {
    await db.delete(reportLines).where(eq(reportLines.reportId, report.id))
    await db.delete(reports).where(eq(reports.id, report.id))
  }

  const [report] = await db.insert(reports).values({ slot, label }).returning()

  if (lines.length > 0) {
    await db.insert(reportLines).values(
      lines.map((line) => ({
        reportId: report.id,
        category: line.category,
        amount: line.amount,
      })),
    )
  }

  return report
}

export async function getAllReports() {
  const allReports = await db.select().from(reports).orderBy(reports.slot)
  const allLines = await db.select().from(reportLines)

  return allReports.map((report) => ({
    ...report,
    lines: allLines.filter((line) => line.reportId === report.id),
  }))
}

export type VarianceRow = {
  category: string
  values: Array<number | null>
  min: number
  max: number
  variance: number
  variancePct: number
}

export function computeVariance(
  reportsWithLines: Awaited<ReturnType<typeof getAllReports>>,
): VarianceRow[] {
  const categories = new Set<string>()
  for (const report of reportsWithLines) {
    for (const line of report.lines) categories.add(line.category)
  }

  const rows: VarianceRow[] = []

  for (const category of categories) {
    const values = reportsWithLines.map((report) => {
      const line = report.lines.find((l) => l.category === category)
      return line ? line.amount : null
    })

    const present = values.filter((v): v is number => v !== null)
    if (present.length === 0) continue

    const min = Math.min(...present)
    const max = Math.max(...present)
    const variance = max - min
    const variancePct = min !== 0 ? (variance / Math.abs(min)) * 100 : variance === 0 ? 0 : 100

    rows.push({ category, values, min, max, variance, variancePct })
  }

  return rows.sort((a, b) => b.variancePct - a.variancePct)
}
