import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  parseReportFile,
  saveReport,
  clearReport,
  getAllReports,
  computeMaterialSummary,
  resolveFootprints,
  listFootprints,
  upsertFootprint,
  deleteFootprintOverride,
  listProductionSchedule,
  REPORT_TYPES,
  type ReportType,
} from './reports.server.js'

const reportTypeSchema = z.enum(REPORT_TYPES as [ReportType, ...ReportType[]])

export const getVarianceData = createServerFn({ method: 'GET' }).handler(async () => {
  const [reportsWithLines, footprints] = await Promise.all([
    getAllReports(),
    resolveFootprints(),
  ])
  const materials = computeMaterialSummary(reportsWithLines, footprints)
  return {
    reports: reportsWithLines.map((r) => ({
      id: r.id,
      type: r.type,
      label: r.label,
      lineCount: r.lines.length,
    })),
    materials,
  }
})

export const uploadReport = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      type: reportTypeSchema,
      label: z.string().min(1).max(120),
      // Uploads are sent as base64 so binary .xlsx files survive the round trip.
      fileBase64: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const buffer = Buffer.from(data.fileBase64, 'base64')
    const lines = parseReportFile(buffer, data.type)
    const report = await saveReport(data.type, data.label, lines)
    return { id: report.id, lineCount: lines.length }
  })

export const removeReport = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ type: reportTypeSchema }))
  .handler(async ({ data }) => clearReport(data.type))

export const getFootprints = createServerFn({ method: 'GET' }).handler(async () =>
  listFootprints(),
)

export const getProductionSchedule = createServerFn({ method: 'GET' }).handler(async () =>
  listProductionSchedule(),
)

export const saveFootprint = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      // Material numbers are digit strings everywhere else in the app; holding
      // to that means a typo can't create a footprint nothing will ever match.
      material: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(/^[0-9]+$/, 'Material number must be digits only'),
      casesPerPallet: z
        .number()
        .positive('Cases per pallet must be greater than zero')
        .max(100000),
    }),
  )
  .handler(async ({ data }) => upsertFootprint(data.material, data.casesPerPallet))

export const resetFootprint = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ material: z.string().trim().min(1).max(40) }))
  .handler(async ({ data }) => deleteFootprintOverride(data.material))
