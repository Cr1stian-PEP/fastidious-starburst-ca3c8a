import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  parseReportFile,
  saveReport,
  clearReport,
  getAllReports,
  computeMaterialSummary,
  deliveryNeedsReupload,
  resolveFootprints,
  listFootprints,
  upsertFootprint,
  deleteFootprintOverride,
  listProductionSchedule,
  buildVarianceExport,
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
    // Load numbers are frozen at upload time, so an outbound export uploaded
    // before the K/L mapping still shows the old column-P numbers until it is
    // uploaded again. The dashboard says so rather than showing them quietly.
    deliveryNeedsReupload: deliveryNeedsReupload(reportsWithLines),
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

const sortDir = z.enum(['asc', 'desc'])

// The dashboard's whole view state, so the workbook can be rebuilt server-side
// as the exact report on screen rather than trusting rows sent up from the tab.
export const exportVarianceWorkbook = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      view: z.enum(['material', 'load']),
      palletView: z.boolean(),
      query: z.string().max(200),
      shortfallsOnly: z.boolean(),
      // By-material view only; the load view ignores it.
      deliveriesOnly: z.boolean(),
      // Blank on either end is open-ended, matching the date inputs.
      from: z.string().max(10),
      to: z.string().max(10),
      condition: z.enum(['01', '02', 'both']),
      // Blank is every site, matching the dropdown's first option.
      site: z.string().max(200),
      materialSort: z.object({
        key: z.enum(['material', 'materialName', 'totalOnHand', 'requested', 'variance']),
        dir: sortDir,
      }),
      loadSort: z.object({
        key: z.enum([
          'orderNumber',
          'customerPO',
          'shipDate',
          'materialCount',
          'totalOnHand',
          'requested',
          'variance',
        ]),
        dir: sortDir,
      }),
      // Both stamps come from the browser so the file is dated in the reader's
      // own time zone rather than the server's.
      generatedAt: z.string().max(80),
      dateStamp: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    }),
  )
  .handler(async ({ data }) => buildVarianceExport(data))
