import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import {
  FileUp,
  AlertTriangle,
  CheckCircle2,
  TrendingDown,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Factory,
  Warehouse,
  Truck,
  Layers,
  Search,
  Filter,
  Trash2,
  Ruler,
  ArrowRight,
  Boxes,
  FileSpreadsheet,
  Printer,
} from 'lucide-react'
import {
  exportVarianceWorkbook,
  getVarianceData,
  removeReport,
  uploadReport,
} from '../server/reports.functions'
import { SortHeader } from '../components/sort-header'
import {
  dateSortKey,
  filterAndSortLoads,
  filterAndSortMaterials,
  filterMaterialsByDelivery,
  sortDeliveries,
  type DeliverySortKey,
  type LoadSortKey,
  type MaterialSortKey,
  type ShippingCondition,
  type SortState,
} from '../lib/table-sort'
import { summarizeLoads, topShortfallMaterials, deliveryLoadKey } from '../lib/shortfalls'
import {
  formatNumber,
  formatCustomerPo,
  formatLoadNumber,
  formatQty,
  formatTotal,
  qtyValue,
  totalUnits,
  totalValue,
  unkeyedNote,
} from '../lib/units'
import {
  buildLoadExport,
  buildMaterialExport,
  type ExportContext,
} from '../lib/report-export'
import { downloadBase64, printExportDocument } from '../lib/print-export'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend)

export const Route = createFileRoute('/')({
  component: Home,
  loader: async () => getVarianceData(),
})

type ReportType = 'production' | 'materials' | 'delivery'

const SLOTS: Array<{
  type: ReportType
  title: string
  hint: string
  icon: typeof Factory
  accent: string
}> = [
  {
    type: 'production',
    title: 'Production',
    hint: 'Material # (col D), Name (col F), Case qty (col G)',
    icon: Factory,
    accent: 'bg-blue-500',
  },
  {
    type: 'materials',
    title: 'Materials',
    hint: 'Material # (col A), Name (col B), Stock qty (col C)',
    icon: Warehouse,
    accent: 'bg-emerald-500',
  },
  {
    type: 'delivery',
    title: 'Outbound loads',
    hint: 'Material # (col Q), Requested qty (col S, cond. col T = 01/02)',
    icon: Truck,
    accent: 'bg-amber-500',
  },
]

// The shortfall chart can be read two ways: which materials are short, or which
// outbound loads are exposed to a shortage. The choice drives the table too.
type ChartGroup = 'material' | 'load'

const CHART_GROUPS: Array<{ value: ChartGroup; label: string; icon: typeof Factory }> = [
  { value: 'material', label: 'By material #', icon: Boxes },
  { value: 'load', label: 'By load #', icon: Truck },
]

const CHART_LIMIT = 15

// Column T on the outbound loads export. Both conditions are stored at upload;
// the default matches what the report has always shown.
const SHIPPING_CONDITIONS: Array<{ value: ShippingCondition; label: string }> = [
  { value: '01', label: '01' },
  { value: '02', label: '02' },
  { value: 'both', label: 'Both' },
]

// Where a chart click should take the reader: always a material row, plus the
// delivery line to point at when the click came from the by-load view.
type RevealTarget = { material: string; load: string | null }

function StatCard({
  icon: Icon,
  accent,
  label,
  value,
  note,
}: {
  icon: typeof Factory
  accent: string
  label: string
  value: string
  note?: string
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
      <div className={`${accent} p-3 rounded-lg shrink-0`}>
        <Icon className="w-6 h-6 text-white" />
      </div>
      <div className="min-w-0">
        <p className="text-sm text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        {note && <p className="text-xs text-gray-400 mt-0.5">{note}</p>}
      </div>
    </div>
  )
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function Home() {
  const router = useRouter()
  const data = Route.useLoaderData()
  const [pending, setPending] = useState<ReportType | null>(null)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [palletView, setPalletView] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [expandedLoad, setExpandedLoad] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [shortfallsOnly, setShortfallsOnly] = useState(false)
  // Ship-date window on the demand side. Blank on either end is open-ended.
  const [shipFrom, setShipFrom] = useState('')
  const [shipTo, setShipTo] = useState('')
  // Shipping condition on the demand side. '02' is what the report showed
  // before the selector existed, so it stays the default.
  const [condition, setCondition] = useState<ShippingCondition>('02')
  const [chartOpen, setChartOpen] = useState(true)
  const [sort, setSort] = useState<SortState<MaterialSortKey>>({
    key: 'material',
    dir: 'asc',
  })
  // Worst loads on top, which is what the view is for.
  const [loadSort, setLoadSort] = useState<SortState<LoadSortKey>>({
    key: 'variance',
    dir: 'asc',
  })
  // Default matches the order the server returns delivery lines in, so the
  // expanded view looks the same until a header is clicked.
  const [deliverySort, setDeliverySort] = useState<SortState<DeliverySortKey>>({
    key: 'shipDate',
    dir: 'asc',
  })
  const [chartGroup, setChartGroup] = useState<ChartGroup>('material')
  // A bar click asks for a row to be revealed; the scroll happens in an effect
  // once that row is actually rendered.
  const [pendingReveal, setPendingReveal] = useState<RevealTarget | null>(null)
  const [highlight, setHighlight] = useState<RevealTarget | null>(null)
  const rowRefs = useRef(new Map<string, HTMLTableRowElement | null>())
  const loadRowRefs = useRef(new Map<string, HTMLTableRowElement | null>())

  const reportsByType = useMemo(
    () => new Map(data.reports.map((r) => [r.type as ReportType, r])),
    [data.reports],
  )

  async function handleFile(type: ReportType, file: File) {
    setPending(type)
    setError(null)
    try {
      const fileBase64 = await fileToBase64(file)
      // Kept with its extension so the tile can show the file that is in it.
      const label = file.name.slice(0, 120)
      await uploadReport({ data: { type, label, fileBase64 } })
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to process report')
    } finally {
      setPending(null)
    }
  }

  async function handleClear(type: ReportType) {
    setPending(type)
    setError(null)
    try {
      await removeReport({ data: { type } })
      setExpanded(null)
      setExpandedLoad(null)
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear report')
    } finally {
      setPending(null)
    }
  }

  // A ship-date window and the shipping condition narrow the demand side before
  // anything is computed, so the tiles, the chart and both tables all read the
  // same filtered figures.
  const allMaterials = data.materials
  const rangeActive = Boolean(shipFrom || shipTo)
  const materials = useMemo(
    () => filterMaterialsByDelivery(allMaterials, { from: shipFrom, to: shipTo, condition }),
    [allMaterials, shipFrom, shipTo, condition],
  )
  // Undated delivery lines can't be shown to fall inside a window, so they are
  // dropped while one is active — worth saying out loud.
  const undatedDropped = useMemo(() => {
    if (!rangeActive) return 0
    return allMaterials.reduce(
      (count, m) =>
        count + m.deliveries.filter((d) => !Number.isFinite(dateSortKey(d.shipDate))).length,
      0,
    )
  }, [allMaterials, rangeActive])

  const missingFootprintCount = materials.filter((m) => !m.casesPerPallet).length

  const shortfallCount = materials.filter((m) => m.variance < 0).length
  // Cases per pallet differs by material, so a page-level pallet figure has to
  // be built up material by material rather than divided at the end.
  const totalFinished = useMemo(
    () => totalUnits(materials, (m) => m.finished),
    [materials],
  )
  const totalRequested = useMemo(
    () => totalUnits(materials, (m) => m.requested),
    [materials],
  )
  const totalToProduce = useMemo(
    () => totalUnits(materials, (m) => m.inProduction),
    [materials],
  )
  // The tile only means anything once there is a schedule behind it, so it
  // appears with the production upload and leaves with it.
  const hasProduction = reportsByType.has('production')

  const topMaterials = useMemo(
    () => topShortfallMaterials(materials, CHART_LIMIT),
    [materials],
  )
  // One allocation pass serves both the chart and the load table.
  const loads = useMemo(() => summarizeLoads(materials), [materials])
  const topLoads = useMemo(
    () =>
      loads
        .filter((load) => load.variance < 0)
        .sort((a, b) => a.variance - b.variance)
        .slice(0, CHART_LIMIT),
    [loads],
  )

  const visibleMaterials = useMemo(
    () => filterAndSortMaterials(materials, { query, shortfallsOnly, sort }),
    [materials, query, shortfallsOnly, sort],
  )
  const visibleLoads = useMemo(
    () => filterAndSortLoads(loads, { query, shortfallsOnly, sort: loadSort }),
    [loads, query, shortfallsOnly, loadSort],
  )
  const loadView = chartGroup === 'load'

  // What the export has to record besides the rows: which filters produced
  // them, in which units, and from which uploads. Timestamps come from here so
  // the file is dated in the reader's own time zone rather than the server's.
  function exportContext(): ExportContext {
    const now = new Date()
    return {
      view: loadView ? 'load' : 'material',
      palletView,
      query,
      shortfallsOnly,
      from: shipFrom,
      to: shipTo,
      condition,
      sources: data.reports.map((r) => r.label),
      generatedAt: now.toLocaleString(),
      dateStamp: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate(),
      ).padStart(2, '0')}`,
      shown: loadView ? visibleLoads.length : visibleMaterials.length,
      total: loadView ? loads.length : materials.length,
    }
  }

  // PDF comes out of the browser's own print dialog, on a copy of the report
  // laid out for paper — the rows are the ones on screen, so no round trip.
  function handleExportPdf() {
    const ctx = exportContext()
    printExportDocument(
      loadView ? buildLoadExport(visibleLoads, ctx) : buildMaterialExport(visibleMaterials, ctx),
    )
  }

  // Excel is written on the server, which rebuilds the view from the same pure
  // filters and the same allocation rather than serialising the tab's rows.
  async function handleExportExcel() {
    setExporting(true)
    setError(null)
    try {
      const ctx = exportContext()
      const file = await exportVarianceWorkbook({
        data: {
          view: ctx.view,
          palletView,
          query,
          shortfallsOnly,
          from: shipFrom,
          to: shipTo,
          condition,
          materialSort: sort,
          loadSort,
          generatedAt: ctx.generatedAt,
          dateStamp: ctx.dateStamp,
        },
      })
      downloadBase64(file.base64, file.fileName)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to build the Excel export')
    } finally {
      setExporting(false)
    }
  }

  // A condition-01 pickup has no load number at all, so it is labelled by its
  // PO instead of being left blank.
  function loadLabel(load: { orderNumber: string; customerPO: string }) {
    const number = formatLoadNumber(load.orderNumber)
    if (number) return number
    const po = formatCustomerPo(load.customerPO)
    return po ? `PO ${po}` : 'No load #'
  }

  // One shape for both groupings, so the chart and its click handler don't care
  // which one is selected. The values follow Pallet View: a bar has to agree
  // with the row it points at, so it is converted the same way — per material
  // in material mode, and material-by-material across the load's own lines in
  // load mode, since cases-per-pallet differs by item.
  const chartRows = useMemo(
    () =>
      chartGroup === 'load'
        ? topLoads.map((load) => {
            const available = totalUnits(load.lines, (l) => l.available)
            const requested = totalUnits(load.lines, (l) => l.requested)
            return {
              label: loadLabel(load),
              totalOnHand: totalValue(available, palletView),
              requested: totalValue(requested, palletView),
              onHandText: formatTotal(available, palletView),
              requestedText: formatTotal(requested, palletView),
              material: load.worstMaterial,
              load: load.key as string | null,
            }
          })
        : topMaterials.map((m) => ({
            label: m.material,
            totalOnHand: qtyValue(m.totalOnHand, m.casesPerPallet, palletView),
            requested: qtyValue(m.requested, m.casesPerPallet, palletView),
            onHandText: formatQty(m.totalOnHand, m.casesPerPallet, palletView),
            requestedText: formatQty(m.requested, m.casesPerPallet, palletView),
            material: m.material,
            load: null,
          })),
    [chartGroup, topLoads, topMaterials, palletView],
  )

  function revealMaterial(target: RevealTarget) {
    if (!target.material) return
    // A search or the shortfalls filter could be hiding the row we are about to
    // scroll to, so relax whichever one would exclude it.
    if (!visibleMaterials.some((m) => m.material === target.material)) {
      setQuery('')
      const row = materials.find((m) => m.material === target.material)
      if (shortfallsOnly && row && row.variance >= 0) setShortfallsOnly(false)
    }
    setExpanded(target.material)
    setPendingReveal(target)
  }

  // In load mode the bars are loads, so a click lands on the load's own row
  // rather than on the material driving it. Loads are addressed by their key,
  // not their load number — condition-01 pickups have none.
  function revealLoad(key: string) {
    if (!key) return
    if (!visibleLoads.some((l) => l.key === key)) {
      setQuery('')
      const load = loads.find((l) => l.key === key)
      if (shortfallsOnly && load && load.variance >= 0) setShortfallsOnly(false)
    }
    setExpandedLoad(key)
    setPendingReveal({ material: '', load: key })
  }

  // Switching the view swaps one kind of row for another, so whatever was open
  // is collapsed rather than carried across.
  function selectChartGroup(group: ChartGroup) {
    if (group === chartGroup) return
    setChartGroup(group)
    setExpanded(null)
    setExpandedLoad(null)
    setHighlight(null)
    setPendingReveal(null)
  }

  useEffect(() => {
    if (!pendingReveal) return
    const row = loadView
      ? loadRowRefs.current.get(pendingReveal.load ?? '')
      : rowRefs.current.get(pendingReveal.material)
    // Not rendered yet — clearing the search re-renders the table and this
    // effect runs again with the row in place.
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlight(pendingReveal)
    setPendingReveal(null)
  }, [pendingReveal, visibleMaterials, visibleLoads, loadView])

  // The highlight is a "you are here" flash, not a selection, so it fades.
  useEffect(() => {
    if (!highlight) return
    const timer = setTimeout(() => setHighlight(null), 4000)
    return () => clearTimeout(timer)
  }, [highlight])

  const chartData = {
    labels: chartRows.map((r) => r.label),
    datasets: [
      {
        label: chartGroup === 'load' ? 'Stock available for this load' : 'Stock on hand',
        data: chartRows.map((r) => r.totalOnHand),
        backgroundColor: 'rgba(16, 185, 129, 0.75)',
        borderRadius: 4,
      },
      {
        label: 'Needed for loads',
        data: chartRows.map((r) => r.requested),
        backgroundColor: 'rgba(245, 158, 11, 0.75)',
        borderRadius: 4,
      },
    ],
  }

  // Left to itself Chart.js rounds the axis floor down to a whole tick step, so
  // a single -3 bar drags the baseline to -2000 and every other bar flattens.
  // Pin the floor to the actual smallest value instead (or 0 when nothing is
  // negative), so the axis only ever descends as far as the data really does.
  const chartMin = useMemo(() => {
    const values = chartRows.flatMap((r) => [r.totalOnHand, r.requested])
    return Math.min(0, ...values)
  }, [chartRows])

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">
              Material Stock Variance Report
            </h1>
            <p className="text-gray-500 max-w-3xl">
              Upload the production schedule, stock multiple report, and
              outbound loads / order monitor report to compare on-hand stock (in
              production + finished) against requested stock for outbound loads,
              by material number.
            </p>
          </div>
          {/* Units are a page-wide choice — the stat tiles and both tables read
              from it — so the toggle sits above everything it changes. */}
          <div className="flex items-center gap-3 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={() => setPalletView((v) => !v)}
              aria-pressed={palletView}
              className={`inline-flex items-center gap-2 text-sm font-medium rounded-lg px-4 py-2 shadow-sm transition-colors ${
                palletView
                  ? 'bg-gray-900 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-100'
              }`}
            >
              <Layers className="w-4 h-4" />
              {palletView ? 'Pallet view: On' : 'Pallet View'}
            </button>
            <Link
              to="/production"
              className="inline-flex items-center gap-2 text-sm font-medium rounded-lg px-4 py-2 bg-white text-gray-700 shadow-sm hover:bg-gray-100 transition-colors"
            >
              <Factory className="w-4 h-4" />
              Production schedule
              <ArrowRight className="w-4 h-4 text-gray-400" />
            </Link>
            <Link
              to="/footprints"
              className="inline-flex items-center gap-2 text-sm font-medium rounded-lg px-4 py-2 bg-white text-gray-700 shadow-sm hover:bg-gray-100 transition-colors"
            >
              <Ruler className="w-4 h-4" />
              Pallet footprints
              <ArrowRight className="w-4 h-4 text-gray-400" />
            </Link>
          </div>
        </div>

        {/* Upload slots */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
          {SLOTS.map((slot) => {
            const report = reportsByType.get(slot.type)
            const Icon = slot.icon
            return (
              <div
                key={slot.type}
                className="bg-white rounded-xl shadow-sm p-6 flex flex-col gap-3"
              >
                <div className="flex items-center gap-3">
                  <div className={`${slot.accent} p-2 rounded-lg`}>
                    <Icon className="w-4 h-4 text-white" />
                  </div>
                  <p className="font-semibold text-gray-900">{slot.title}</p>
                </div>
                <p className="text-xs text-gray-400">{slot.hint}</p>
                {report ? (
                  <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2">
                    <div className="flex items-start gap-2 text-sm text-emerald-700">
                      <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                      <span className="font-medium break-all" title={report.label}>
                        {report.label}
                      </span>
                    </div>
                    <p className="text-xs text-emerald-600/80 mt-1 pl-6">
                      {formatNumber(report.lineCount)} line
                      {report.lineCount === 1 ? '' : 's'} loaded
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">No file uploaded yet</p>
                )}
                <div className="mt-auto flex items-center gap-2">
                  <label className="flex-1 inline-flex items-center justify-center gap-2 cursor-pointer bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors">
                    <FileUp className="w-4 h-4" />
                    {pending === slot.type
                      ? 'Working…'
                      : report
                        ? 'Replace file'
                        : 'Upload file'}
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      className="hidden"
                      disabled={pending !== null}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) handleFile(slot.type, file)
                        e.target.value = ''
                      }}
                    />
                  </label>
                  {report && (
                    <button
                      type="button"
                      disabled={pending !== null}
                      onClick={() => handleClear(slot.type)}
                      title={`Clear ${report.label}`}
                      className="inline-flex items-center gap-1.5 text-sm font-medium rounded-lg px-3 py-2 text-gray-600 bg-gray-100 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {error && (
          <div className="mb-8 flex items-center gap-2 bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-3 text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Load numbers are read at upload time, so a report uploaded under the
            old column-P mapping keeps its old load numbers until it is uploaded
            again. Nothing on this page can fix that, so it asks. */}
        {data.deliveryNeedsReupload && (
          <div className="mb-8 flex items-start gap-2 bg-amber-50 text-amber-800 border border-amber-200 rounded-lg px-4 py-3 text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              The outbound loads report was uploaded before load numbers moved
              to column L. Its load numbers still come from the old column P —
              which is blank on <strong>02</strong> rows and zero-padded on{' '}
              <strong>01</strong> rows. Upload the outbound loads export again
              to pick up the new mapping.
            </span>
          </div>
        )}

        {materials.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center text-gray-400">
            Upload at least one of production/materials and the delivery
            report to see a variance comparison.
          </div>
        ) : (
          <>
            {/* Stat cards */}
            <div
              className={`grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8 ${
                hasProduction ? 'lg:grid-cols-5' : 'lg:grid-cols-4'
              }`}
            >
              <StatCard
                icon={Warehouse}
                accent="bg-gray-900"
                label="Materials tracked"
                value={formatNumber(materials.length)}
              />
              <StatCard
                icon={Boxes}
                accent="bg-emerald-500"
                label="Finished Goods"
                value={formatTotal(totalFinished, palletView)}
                note={unkeyedNote(totalFinished, palletView)}
              />
              {hasProduction && (
                <StatCard
                  icon={Factory}
                  accent="bg-blue-500"
                  label="To be produced"
                  value={formatTotal(totalToProduce, palletView)}
                  note={unkeyedNote(totalToProduce, palletView)}
                />
              )}
              <StatCard
                icon={Truck}
                accent="bg-amber-500"
                label="Needed for loads"
                value={formatTotal(totalRequested, palletView)}
                note={unkeyedNote(totalRequested, palletView)}
              />
              <StatCard
                icon={TrendingDown}
                accent="bg-red-500"
                label="Shortfalls"
                value={formatNumber(shortfallCount)}
              />
            </div>

            {/* Chart */}
            <div className="bg-white rounded-xl shadow-sm p-6 mb-8">
                <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">
                      Largest shortfalls (stock on hand vs. needed for loads)
                    </h2>
                    <p className="text-xs text-gray-400 mt-1 max-w-2xl">
                      {loadView
                        ? 'Grouped by load number, filled in ship-date order: the stock a load can draw on is what is left after every earlier load has taken its share, so the two bars are that load’s own demand — what it can get against what it asks for. A pickup with no load number is labelled by its Customer PO. Click a bar to jump to that load’s row in the table below.'
                        : 'Grouped by material number. Click a bar to jump to that material’s row in the table below.'}
                      {palletView
                        ? ' Bars follow Pallet View; materials with no footprint stay in cases.'
                        : ''}
                    </p>
                  </div>
                  {/* View controls: the grouping drives the table as well as the
                      chart, and the ship-date window narrows both. */}
                  <div className="flex items-center gap-3 flex-wrap shrink-0">
                    <div className="inline-flex shrink-0 rounded-lg bg-gray-100 p-1">
                      {CHART_GROUPS.map((group) => {
                        const GroupIcon = group.icon
                        const active = chartGroup === group.value
                        return (
                          <button
                            key={group.value}
                            type="button"
                            onClick={() => selectChartGroup(group.value)}
                            aria-pressed={active}
                            className={`inline-flex items-center gap-2 text-sm font-medium rounded-md px-3 py-1.5 transition-colors ${
                              active
                                ? 'bg-white text-gray-900 shadow-sm'
                                : 'text-gray-500 hover:text-gray-900'
                            }`}
                          >
                            <GroupIcon className="w-4 h-4" />
                            {group.label}
                          </button>
                        )
                      })}
                    </div>
                    <div className="flex items-end gap-2">
                      <div>
                        <label
                          htmlFor="ship-from"
                          className="block text-xs font-medium text-gray-500 mb-1"
                        >
                          From
                        </label>
                        <input
                          id="ship-from"
                          type="date"
                          value={shipFrom}
                          onChange={(e) => setShipFrom(e.target.value)}
                          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="ship-to"
                          className="block text-xs font-medium text-gray-500 mb-1"
                        >
                          To
                        </label>
                        <input
                          id="ship-to"
                          type="date"
                          value={shipTo}
                          onChange={(e) => setShipTo(e.target.value)}
                          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
                        />
                      </div>
                      {rangeActive && (
                        <button
                          type="button"
                          onClick={() => {
                            setShipFrom('')
                            setShipTo('')
                          }}
                          className="text-sm font-medium text-gray-500 hover:text-gray-900 rounded-lg px-3 py-1.5 hover:bg-gray-100 transition-colors"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {/* Shipping condition (column T) on the outbound loads
                        export — both are stored, so either can be read. */}
                    <div>
                      <span className="block text-xs font-medium text-gray-500 mb-1">
                        Shipping condition
                      </span>
                      <div className="inline-flex shrink-0 rounded-lg bg-gray-100 p-1">
                        {SHIPPING_CONDITIONS.map((option) => {
                          const active = condition === option.value
                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => setCondition(option.value)}
                              aria-pressed={active}
                              className={`inline-flex items-center gap-2 text-sm font-medium rounded-md px-3 py-1 transition-colors ${
                                active
                                  ? 'bg-white text-gray-900 shadow-sm'
                                  : 'text-gray-500 hover:text-gray-900'
                              }`}
                            >
                              {option.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setChartOpen((v) => !v)}
                      aria-expanded={chartOpen}
                      title={chartOpen ? 'Hide chart' : 'Show chart'}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900 rounded-lg px-3 py-1.5 hover:bg-gray-100 transition-colors"
                    >
                      {chartOpen ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                      {chartOpen ? 'Hide chart' : 'Show chart'}
                    </button>
                  </div>
                </div>
                {rangeActive && undatedDropped > 0 && (
                  <p className="text-xs text-gray-400 -mt-2 mb-4">
                    {formatNumber(undatedDropped)} delivery line
                    {undatedDropped === 1 ? '' : 's'} with no ship date
                    {undatedDropped === 1 ? ' is' : ' are'} excluded while a date
                    range is set.
                  </p>
                )}
                {/* Only the clip animates. The canvas box below is a fixed
                    height, because Chart.js watches its container with a
                    ResizeObserver: animating the container's own height (the
                    grid-rows trick) makes the chart re-lay out on every frame
                    and fight the transition. */}
                <div
                  className={`overflow-hidden transition-[max-height,opacity] duration-300 ease-out ${
                    chartOpen ? 'max-h-[420px] opacity-100' : 'max-h-0 opacity-0'
                  }`}
                >
                  <div className="h-[380px]">
                {chartRows.length === 0 ? (
                  <p className="text-sm text-gray-400 py-8 text-center">
                    No load is short — every load’s materials have enough stock
                    on hand.
                  </p>
                ) : (
                  <Bar
                    data={chartData}
                    options={{
                      responsive: true,
                      // The wrapper fixes the height, so the canvas fills it
                      // rather than deriving one from its own aspect ratio.
                      maintainAspectRatio: false,
                      plugins: {
                        legend: { position: 'bottom' },
                        tooltip: {
                          callbacks: {
                            // The bars carry pallet numbers in pallet view, so
                            // the tooltip has to name the unit it is showing.
                            label: (item) => {
                              const row = chartRows[item.dataIndex]
                              if (!row) return item.formattedValue
                              const value =
                                item.datasetIndex === 0 ? row.onHandText : row.requestedText
                              return `${item.dataset.label}: ${value}`
                            },
                            afterTitle: (items) => {
                              if (chartGroup !== 'load') return ''
                              const load = topLoads[items[0]?.dataIndex ?? -1]
                              if (!load) return ''
                              const short = totalUnits(load.lines, (l) => Math.abs(l.variance))
                              return [
                                load.shipDate ? `Ships ${load.shipDate}` : 'No ship date',
                                `${load.materials.length} material${
                                  load.materials.length === 1 ? '' : 's'
                                }`,
                                `short ${formatTotal(short, palletView)}`,
                              ].join(' · ')
                            },
                          },
                        },
                      },
                      scales: {
                        y: { min: chartMin, beginAtZero: chartMin === 0, ticks: { precision: 0 } },
                      },
                      onClick: (_event, elements) => {
                        const clicked = elements[0]
                        if (!clicked) return
                        const row = chartRows[clicked.index]
                        if (!row) return
                        if (loadView) revealLoad(row.load ?? '')
                        else revealMaterial({ material: row.material, load: row.load })
                      },
                      onHover: (event, elements) => {
                        const target = event.native?.target
                        if (target instanceof HTMLElement) {
                          target.style.cursor = elements.length ? 'pointer' : 'default'
                        }
                      },
                    }}
                  />
                )}
                  </div>
                </div>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl shadow-sm p-6 overflow-x-auto">
              <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                <h2 className="text-lg font-semibold text-gray-900">
                  {loadView ? 'Variance by load' : 'Variance by material'}
                </h2>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="relative">
                    <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={
                        loadView ? 'Find load, PO, plant, or material' : 'Find material or name'
                      }
                      className="text-sm border border-gray-200 rounded-lg pl-9 pr-3 py-2 w-56 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setShortfallsOnly((v) => !v)}
                    aria-pressed={shortfallsOnly}
                    className={`inline-flex items-center gap-2 text-sm font-medium rounded-lg px-4 py-2 transition-colors ${
                      shortfallsOnly
                        ? 'bg-red-600 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    <Filter className="w-4 h-4" />
                    {shortfallsOnly ? 'Shortfalls only: On' : 'Shortfalls Only'}
                  </button>
                  {/* Exports are of the report as it is on screen — the same
                      grouping, filters, sort and units — so they sit with the
                      controls that decide all of that. */}
                  <div className="inline-flex rounded-lg bg-gray-100 p-1">
                    <button
                      type="button"
                      onClick={handleExportExcel}
                      disabled={exporting}
                      title="Download this view as an Excel workbook"
                      className="inline-flex items-center gap-2 text-sm font-medium rounded-md px-3 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-white hover:shadow-sm disabled:opacity-50 transition-colors"
                    >
                      <FileSpreadsheet className="w-4 h-4" />
                      {exporting ? 'Building…' : 'Excel'}
                    </button>
                    <button
                      type="button"
                      onClick={handleExportPdf}
                      title="Open a print-ready copy of this view — save it as PDF"
                      className="inline-flex items-center gap-2 text-sm font-medium rounded-md px-3 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-white hover:shadow-sm transition-colors"
                    >
                      <Printer className="w-4 h-4" />
                      PDF
                    </button>
                  </div>
                </div>
              </div>
              {palletView && missingFootprintCount > 0 && (
                <p className="text-xs text-gray-400 mb-3">
                  {missingFootprintCount} material(s) have no footprint key
                  match — shown in cases (cs) instead of pallets.
                </p>
              )}
              {loadView && (
                <>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-100">
                        <th className="py-2 pr-4 w-6"></th>
                        <SortHeader
                          label="Load #"
                          sortKey="orderNumber"
                          state={loadSort}
                          onChange={setLoadSort}
                          className="py-2 pr-4"
                        />
                        <SortHeader
                          label="Customer PO"
                          sortKey="customerPO"
                          state={loadSort}
                          onChange={setLoadSort}
                          className="py-2 pr-4"
                        />
                        <SortHeader
                          label="Ship Date"
                          sortKey="shipDate"
                          state={loadSort}
                          onChange={setLoadSort}
                          className="py-2 pr-4"
                        />
                        <SortHeader
                          label="Materials"
                          sortKey="materialCount"
                          state={loadSort}
                          onChange={setLoadSort}
                          className="py-2 pr-4"
                        />
                        <SortHeader
                          label="Stock Available"
                          sortKey="totalOnHand"
                          state={loadSort}
                          onChange={setLoadSort}
                          className="py-2 pr-4"
                        />
                        <SortHeader
                          label="Needed for Loads"
                          sortKey="requested"
                          state={loadSort}
                          onChange={setLoadSort}
                          className="py-2 pr-4"
                        />
                        <SortHeader
                          label="Variance"
                          sortKey="variance"
                          state={loadSort}
                          onChange={setLoadSort}
                          className="py-2"
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleLoads.map((load) => {
                        const isOpen = expandedLoad === load.key
                        const flagged = load.variance < 0
                        const isHighlighted = highlight?.load === load.key
                        // Pallet figures are built material by material, the
                        // same way the stat tiles do it.
                        const available = totalUnits(load.lines, (l) => l.available)
                        const needed = totalUnits(load.lines, (l) => l.requested)
                        const variance = totalUnits(load.lines, (l) => l.variance)
                        const loadNumber = formatLoadNumber(load.orderNumber)
                        return (
                          <Fragment key={load.key}>
                            <tr
                              ref={(el) => {
                                loadRowRefs.current.set(load.key, el)
                              }}
                              onClick={() =>
                                setExpandedLoad(isOpen ? null : load.key)
                              }
                              className={`border-b border-gray-50 last:border-0 cursor-pointer transition-colors ${
                                isHighlighted
                                  ? 'bg-amber-50 ring-2 ring-inset ring-amber-400'
                                  : 'hover:bg-gray-50'
                              }`}
                            >
                              <td className="py-2 pr-4 text-gray-400">
                                {isOpen ? (
                                  <ChevronDown className="w-4 h-4" />
                                ) : (
                                  <ChevronRight className="w-4 h-4" />
                                )}
                              </td>
                              <td className="py-2 pr-4 font-mono text-gray-900">
                                {loadNumber || (
                                  // A condition-01 pickup has no load number.
                                  // Say so on the row itself; the PO beside it
                                  // is what identifies it.
                                  <span className="text-gray-400 italic font-sans">
                                    No load #
                                  </span>
                                )}
                              </td>
                              <td className="py-2 pr-4 text-gray-700">
                                {formatCustomerPo(load.customerPO) || '—'}
                              </td>
                              <td className="py-2 pr-4 text-gray-700">
                                {load.shipDate || '—'}
                              </td>
                              <td className="py-2 pr-4 text-gray-600">
                                {formatNumber(load.materials.length)}
                              </td>
                              <td className="py-2 pr-4 text-gray-600">
                                {formatTotal(available, palletView)}
                              </td>
                              <td className="py-2 pr-4 text-gray-600">
                                {formatTotal(needed, palletView)}
                              </td>
                              <td
                                className={`py-2 font-semibold ${
                                  flagged ? 'text-red-600' : 'text-emerald-600'
                                }`}
                              >
                                {formatTotal(variance, palletView)}
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="bg-gray-50/60">
                                <td colSpan={8} className="px-4 py-4">
                                  {/* Where the load comes from and where it is
                                      going — one pair for the whole load, so it
                                      sits above the per-material table rather
                                      than repeating down every row. */}
                                  <dl className="flex flex-wrap gap-x-10 gap-y-2 mb-4">
                                    <div>
                                      <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                                        Ship From
                                      </dt>
                                      <dd className="text-xs text-gray-700">
                                        {load.shipFrom || '—'}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-[11px] uppercase tracking-wide text-gray-400">
                                        Ship To
                                      </dt>
                                      <dd className="text-xs text-gray-700">
                                        {load.shipTo || '—'}
                                      </dd>
                                    </div>
                                  </dl>
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-left text-gray-400 border-b border-gray-200">
                                        <th className="py-1 pr-4 font-medium">Material</th>
                                        <th className="py-1 pr-4 font-medium">Name</th>
                                        <th className="py-1 pr-4 font-medium">Needed</th>
                                        <th className="py-1 pr-4 font-medium">Available</th>
                                        <th className="py-1 font-medium">Variance</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {load.lines.map((line) => (
                                        <tr
                                          key={line.material}
                                          className="border-b border-gray-100 last:border-0"
                                        >
                                          <td className="py-1 pr-4 font-mono text-gray-700">
                                            {line.material}
                                          </td>
                                          <td className="py-1 pr-4 text-gray-700">
                                            {line.materialName}
                                          </td>
                                          <td className="py-1 pr-4 text-gray-700">
                                            {formatQty(
                                              line.requested,
                                              line.casesPerPallet,
                                              palletView,
                                            )}
                                          </td>
                                          <td className="py-1 pr-4 text-gray-700">
                                            {formatQty(
                                              line.available,
                                              line.casesPerPallet,
                                              palletView,
                                            )}
                                          </td>
                                          <td
                                            className={`py-1 font-semibold ${
                                              line.variance < 0
                                                ? 'text-red-600'
                                                : 'text-emerald-600'
                                            }`}
                                          >
                                            {formatQty(
                                              line.variance,
                                              line.casesPerPallet,
                                              palletView,
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                  {visibleLoads.length === 0 && (
                    <p className="text-sm text-gray-400 py-8 text-center">
                      {!shortfallsOnly
                        ? `No loads match “${query}”.`
                        : query.trim()
                          ? `No short loads match “${query}”.`
                          : 'No load is short — every load’s materials have enough stock on hand.'}
                    </p>
                  )}
                  <p className="text-xs text-gray-400 mt-3">
                    Showing {formatNumber(visibleLoads.length)} of{' '}
                    {formatNumber(loads.length)} loads
                    {shortfallsOnly && ' (shortfalls only)'}
                  </p>
                </>
              )}
              {!loadView && (
                <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-4 w-6"></th>
                    <SortHeader
                      label="Material"
                      sortKey="material"
                      state={sort}
                      onChange={setSort}
                      className="py-2 pr-4"
                    />
                    <SortHeader
                      label="Name"
                      sortKey="materialName"
                      state={sort}
                      onChange={setSort}
                      className="py-2 pr-4"
                    />
                    <SortHeader
                      label="Stock on Hand"
                      sortKey="totalOnHand"
                      state={sort}
                      onChange={setSort}
                      className="py-2 pr-4"
                    />
                    <SortHeader
                      label="Stock Needed for Loads"
                      sortKey="requested"
                      state={sort}
                      onChange={setSort}
                      className="py-2 pr-4"
                    />
                    <SortHeader
                      label="Variance"
                      sortKey="variance"
                      state={sort}
                      onChange={setSort}
                      className="py-2"
                    />
                  </tr>
                </thead>
                <tbody>
                  {visibleMaterials.map((row) => {
                    const isOpen = expanded === row.material
                    const flagged = row.variance < 0
                    const isHighlighted = highlight?.material === row.material
                    return (
                      <Fragment key={row.material}>
                        <tr
                          ref={(el) => {
                            rowRefs.current.set(row.material, el)
                          }}
                          onClick={() =>
                            setExpanded(isOpen ? null : row.material)
                          }
                          className={`border-b border-gray-50 last:border-0 cursor-pointer transition-colors ${
                            isHighlighted
                              ? 'bg-amber-50 ring-2 ring-inset ring-amber-400'
                              : 'hover:bg-gray-50'
                          }`}
                        >
                          <td className="py-2 pr-4 text-gray-400">
                            {isOpen ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </td>
                          <td className="py-2 pr-4 font-mono text-gray-900">
                            {row.material}
                          </td>
                          <td className="py-2 pr-4 text-gray-700">
                            {row.materialName}
                          </td>
                          <td className="py-2 pr-4 text-gray-600">
                            {formatQty(row.totalOnHand, row.casesPerPallet, palletView)}
                          </td>
                          <td className="py-2 pr-4 text-gray-600">
                            {formatQty(row.requested, row.casesPerPallet, palletView)}
                          </td>
                          <td
                            className={`py-2 font-semibold ${
                              flagged ? 'text-red-600' : 'text-emerald-600'
                            }`}
                          >
                            {formatQty(row.variance, row.casesPerPallet, palletView)}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-gray-50/60">
                            <td colSpan={6} className="px-4 py-4">
                              <div className="flex flex-wrap gap-4 mb-4">
                                <div className="bg-white rounded-lg px-4 py-2 shadow-sm">
                                  <p className="text-xs text-gray-400">
                                    In production
                                  </p>
                                  <p className="font-semibold text-gray-900">
                                    {formatQty(row.inProduction, row.casesPerPallet, palletView)}
                                  </p>
                                </div>
                                <div className="bg-white rounded-lg px-4 py-2 shadow-sm">
                                  <p className="text-xs text-gray-400">
                                    Finished
                                  </p>
                                  <p className="font-semibold text-gray-900">
                                    {formatQty(row.finished, row.casesPerPallet, palletView)}
                                  </p>
                                </div>
                                <div className="bg-white rounded-lg px-4 py-2 shadow-sm">
                                  <p className="text-xs text-gray-400">
                                    Total on hand
                                  </p>
                                  <p className="font-semibold text-gray-900">
                                    {formatQty(row.totalOnHand, row.casesPerPallet, palletView)}
                                  </p>
                                </div>
                                {row.casesPerPallet && (
                                  <div className="bg-white rounded-lg px-4 py-2 shadow-sm">
                                    <p className="text-xs text-gray-400">
                                      Cases per pallet
                                    </p>
                                    <p className="font-semibold text-gray-900">
                                      {row.casesPerPallet}
                                    </p>
                                  </div>
                                )}
                              </div>
                              {/* What the schedule actually commits, and when.
                                  Nothing in production means nothing to show. */}
                              {row.inProduction > 0 &&
                                (row.production.length > 0 ? (
                                  <div className="mb-4">
                                    <p className="text-xs font-semibold text-gray-500 mb-1">
                                      Scheduled production
                                    </p>
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="text-left text-gray-400 border-b border-gray-200">
                                          <th className="py-1 pr-4 font-medium">Date</th>
                                          <th className="py-1 font-medium">Quantity</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {row.production.map((entry, i) => (
                                          <tr
                                            key={`${entry.date}-${i}`}
                                            className="border-b border-gray-100 last:border-0"
                                          >
                                            <td className="py-1 pr-4 text-gray-700">
                                              {entry.date || 'No date on the schedule'}
                                            </td>
                                            <td className="py-1 text-gray-700">
                                              {formatQty(
                                                entry.quantity,
                                                row.casesPerPallet,
                                                palletView,
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <p className="text-xs text-gray-500 mb-4">
                                    <span className="font-semibold">Scheduled production:</span>{' '}
                                    {formatQty(row.inProduction, row.casesPerPallet, palletView)} —
                                    the schedule rows carried no date.
                                  </p>
                                ))}
                              {row.deliveries.length === 0 ? (
                                <p className="text-sm text-gray-400">
                                  No delivery lines for this material.
                                </p>
                              ) : (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-left text-gray-400 border-b border-gray-200">
                                      <SortHeader
                                        label="Load #"
                                        sortKey="orderNumber"
                                        state={deliverySort}
                                        onChange={setDeliverySort}
                                        className="py-1 pr-4"
                                        dense
                                      />
                                      <SortHeader
                                        label="Customer PO"
                                        sortKey="customerPO"
                                        state={deliverySort}
                                        onChange={setDeliverySort}
                                        className="py-1 pr-4"
                                        dense
                                      />
                                      <SortHeader
                                        label="Plant"
                                        sortKey="plantName"
                                        state={deliverySort}
                                        onChange={setDeliverySort}
                                        className="py-1 pr-4"
                                        dense
                                      />
                                      <SortHeader
                                        label="Sold-To"
                                        sortKey="soldTo"
                                        state={deliverySort}
                                        onChange={setDeliverySort}
                                        className="py-1 pr-4"
                                        dense
                                      />
                                      <SortHeader
                                        label="Ship Date"
                                        sortKey="shipDate"
                                        state={deliverySort}
                                        onChange={setDeliverySort}
                                        className="py-1 pr-4"
                                        dense
                                      />
                                      <SortHeader
                                        label="Quantity"
                                        sortKey="quantity"
                                        state={deliverySort}
                                        onChange={setDeliverySort}
                                        className="py-1"
                                        dense
                                      />
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sortDeliveries(row.deliveries, deliverySort).map((d, i) => {
                                      // The highlight target is a load key, so
                                      // the line has to be keyed the same way —
                                      // a line with no load number belongs to
                                      // its PO's load, not to nothing.
                                      const isTargetLine =
                                        isHighlighted &&
                                        !!highlight?.load &&
                                        deliveryLoadKey(d) === highlight.load
                                      return (
                                        <tr
                                          key={i}
                                          className={`border-b border-gray-100 last:border-0 ${
                                            isTargetLine
                                              ? 'bg-amber-100/80 font-medium'
                                              : ''
                                          }`}
                                        >
                                          <td className="py-1 pr-4 text-gray-700">
                                            {formatLoadNumber(d.orderNumber) || '—'}
                                          </td>
                                          <td className="py-1 pr-4 text-gray-700">
                                            {formatCustomerPo(d.customerPO) || '—'}
                                          </td>
                                          <td className="py-1 pr-4 text-gray-700">
                                            {d.plantName || '—'}
                                          </td>
                                          <td className="py-1 pr-4 text-gray-700">
                                            {d.soldTo || '—'}
                                          </td>
                                          <td className="py-1 pr-4 text-gray-700">
                                            {d.shipDate || '—'}
                                          </td>
                                          <td className="py-1 text-gray-700">
                                            {formatQty(d.quantity, row.casesPerPallet, palletView)}
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
              {visibleMaterials.length === 0 && (
                <p className="text-sm text-gray-400 py-8 text-center">
                  {!shortfallsOnly
                    ? `No materials match “${query}”.`
                    : query.trim()
                      ? `No shortfalls match “${query}”.`
                      : 'No shortfalls — every material has enough stock on hand.'}
                </p>
              )}
              <p className="text-xs text-gray-400 mt-3">
                Showing {formatNumber(visibleMaterials.length)} of{' '}
                {formatNumber(materials.length)} materials
                {shortfallsOnly && ' (shortfalls only)'}
              </p>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
