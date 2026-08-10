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
import {
  SESSION_IDLE_MINUTES,
  ensureSession,
  resetCurrentSession,
} from './session.server.js'

const reportTypeSchema = z.enum(REPORT_TYPES as [ReportType, ...ReportType[]])

// Uploaded reports belong to the browser visit that made them: every function
// below resolves that session first and reads or writes nothing outside it, so
// simultaneous users never see each other's files and a fresh visit starts with
// empty slots. See session.server.ts.
export const getVarianceData = createServerFn({ method: 'GET' }).handler(async () => {
  const sessionId = await ensureSession()
  const [reportsWithLines, footprints] = await Promise.all([
    getAllReports(sessionId),
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
    // So the page can say how long an unattended report survives.
    sessionIdleMinutes: SESSION_IDLE_MINUTES,
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
    const sessionId = await ensureSession()
    const buffer = Buffer.from(data.fileBase64, 'base64')
    const lines = parseReportFile(buffer, data.type)
    const report = await saveReport(sessionId, data.type, data.label, lines)
    return { id: report.id, lineCount: lines.length }
  })

export const removeReport = createServerFn({ method: 'POST' })
  .inputValidator(z.object({ type: reportTypeSchema }))
  .handler(async ({ data }) => clearReport(await ensureSession(), data.type))

// Drops all three uploads at once by ending the session that owns them and
// handing back a new empty one.
export const clearAllReports = createServerFn({ method: 'POST' }).handler(async () => {
  await resetCurrentSession()
  return { cleared: true }
})

export const getFootprints = createServerFn({ method: 'GET' }).handler(async () =>
  listFootprints(await ensureSession()),
)

export const getProductionSchedule = createServerFn({ method: 'GET' }).handler(async () =>
  listProductionSchedule(await ensureSession()),
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
  .handler(async ({ data }) => buildVarianceExport(await ensureSession(), data))
