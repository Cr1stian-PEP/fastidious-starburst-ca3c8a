import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  parseCsv,
  saveReport,
  getAllReports,
  computeVariance,
} from './reports.server.js'

export const getVarianceData = createServerFn({ method: 'GET' }).handler(
  async () => {
    const reportsWithLines = await getAllReports()
    const variance = computeVariance(reportsWithLines)
    return {
      reports: reportsWithLines.map((r) => ({
        id: r.id,
        slot: r.slot,
        label: r.label,
      })),
      variance,
    }
  },
)

export const uploadReport = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      slot: z.number().int().min(1).max(3),
      label: z.string().min(1).max(120),
      csvText: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const lines = parseCsv(data.csvText)
    const report = await saveReport(data.slot, data.label, lines)
    return { id: report.id, lineCount: lines.length }
  })
