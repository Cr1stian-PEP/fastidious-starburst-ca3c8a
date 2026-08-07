import { createFileRoute, Link } from '@tanstack/react-router'
import { Fragment, useMemo, useState } from 'react'
import { ArrowLeft, Boxes, CalendarDays, Factory, Layers, Search } from 'lucide-react'
import { getProductionSchedule } from '../server/reports.functions'
import { compareMaterialNumber, dateSortKey } from '../lib/table-sort'
import { formatNumber, formatQty, formatTotal, totalUnits, unkeyedNote } from '../lib/units'

export const Route = createFileRoute('/production')({
  component: Production,
  loader: async () => getProductionSchedule(),
})

type ScheduleLine = {
  material: string
  materialName: string
  quantity: number
  date: string
  casesPerPallet: number | null
}

// The schedule is read a day at a time, so the rows are presented the way the
// source export lays them out: a date heading with its own total, then the
// materials scheduled under it. Cases per pallet differs by material, so a
// date's total is built up row by row rather than divided at the end.
function groupByDate(lines: readonly ScheduleLine[]) {
  const byDate = new Map<string, ScheduleLine[]>()
  for (const line of lines) {
    const list = byDate.get(line.date) ?? []
    list.push(line)
    byDate.set(line.date, list)
  }

  return [...byDate.entries()]
    .map(([date, rows]) => ({
      date,
      rows: [...rows].sort((a, b) => compareMaterialNumber(a.material, b.material)),
      total: totalUnits(rows, (row) => row.quantity),
    }))
    .sort((a, b) => {
      const ka = dateSortKey(a.date)
      const kb = dateSortKey(b.date)
      if (ka === kb) return 0
      // Rows above the schedule's first date heading have no date; they sit at
      // the end rather than leading the page.
      if (!Number.isFinite(ka)) return 1
      if (!Number.isFinite(kb)) return -1
      return ka - kb
    })
}

function Production() {
  const lines = Route.useLoaderData()
  const [query, setQuery] = useState('')
  const [palletView, setPalletView] = useState(false)

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? lines.filter(
          (line) =>
            line.material.toLowerCase().includes(q) ||
            line.materialName.toLowerCase().includes(q),
        )
      : lines
    return groupByDate(filtered)
  }, [lines, query])

  const scheduledTotal = useMemo(
    () => totalUnits(lines, (line) => line.quantity),
    [lines],
  )
  const dateCount = useMemo(
    () => new Set(lines.map((line) => line.date)).size,
    [lines],
  )
  // A material with no footprint key match can't be converted, so it stays in
  // cases — worth counting rather than leaving the reader to spot the 'cs'.
  const missingFootprintCount = useMemo(
    () => new Set(lines.filter((l) => !l.casesPerPallet).map((l) => l.material)).size,
    [lines],
  )
  const visibleCount = groups.reduce((sum, group) => sum + group.rows.length, 0)

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to variance report
        </Link>

        <div className="flex items-start justify-between gap-4 flex-wrap mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Production Schedule</h1>
            <p className="text-gray-500 max-w-3xl">
              The uploaded production schedule as it stands, grouped by
              production date. Quantities are cases as the export gives them,
              or pallets with Pallet View on.
            </p>
          </div>
          {/* Units are a page-wide choice here too — the tiles, the date totals
              and the rows all read from it — so the toggle sits above them. */}
          <button
            type="button"
            onClick={() => setPalletView((v) => !v)}
            aria-pressed={palletView}
            className={`inline-flex items-center gap-2 text-sm font-medium rounded-lg px-4 py-2 shadow-sm shrink-0 transition-colors ${
              palletView ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Layers className="w-4 h-4" />
            {palletView ? 'Pallet view: On' : 'Pallet View'}
          </button>
        </div>

        {lines.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center text-gray-400">
            No production report is loaded.{' '}
            <Link to="/" className="text-gray-600 underline hover:text-gray-900">
              Upload one on the variance report
            </Link>{' '}
            to see the schedule here.
          </div>
        ) : (
          <>
            {/* Summary */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
              <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
                <div className="bg-blue-500 p-3 rounded-lg">
                  <Factory className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Scheduled lines</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {formatNumber(lines.length)}
                  </p>
                </div>
              </div>
              <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
                <div className="bg-gray-900 p-3 rounded-lg">
                  <CalendarDays className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Production dates</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {formatNumber(dateCount)}
                  </p>
                </div>
              </div>
              <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
                <div className="bg-emerald-500 p-3 rounded-lg shrink-0">
                  <Boxes className="w-6 h-6 text-white" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-gray-500">
                    {palletView ? 'Total scheduled' : 'Total cases'}
                  </p>
                  <p className="text-2xl font-bold text-gray-900">
                    {formatTotal(scheduledTotal, palletView)}
                  </p>
                  {unkeyedNote(scheduledTotal, palletView) && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      {unkeyedNote(scheduledTotal, palletView)}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl shadow-sm p-6 overflow-x-auto">
              <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                <h2 className="text-lg font-semibold text-gray-900">Schedule by date</h2>
                <div className="relative">
                  <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find material or name"
                    className="text-sm border border-gray-200 rounded-lg pl-9 pr-3 py-2 w-56 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
                  />
                </div>
              </div>

              {palletView && missingFootprintCount > 0 && (
                <p className="text-xs text-gray-400 mb-3">
                  {missingFootprintCount} material(s) have no footprint key
                  match — shown in cases (cs) instead of pallets.
                </p>
              )}

              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-4 font-medium">Material</th>
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 font-medium">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <Fragment key={group.date}>
                      <tr className="bg-gray-50">
                        <td
                          colSpan={2}
                          className="py-2 pr-4 font-semibold text-gray-900"
                        >
                          {group.date || 'No date on the schedule'}
                        </td>
                        <td className="py-2 font-semibold text-gray-900">
                          {formatTotal(group.total, palletView)}
                        </td>
                      </tr>
                      {group.rows.map((row, i) => (
                        <tr
                          key={`${group.date}-${row.material}-${i}`}
                          className="border-b border-gray-50 last:border-0 hover:bg-gray-50"
                        >
                          <td className="py-2 pr-4 font-mono text-gray-900">
                            {row.material}
                          </td>
                          <td className="py-2 pr-4 text-gray-700">{row.materialName}</td>
                          <td className="py-2 text-gray-600">
                            {formatQty(row.quantity, row.casesPerPallet, palletView)}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>

              {visibleCount === 0 && (
                <p className="text-sm text-gray-400 py-8 text-center">
                  No scheduled materials match “{query}”.
                </p>
              )}

              <p className="text-xs text-gray-400 mt-3">
                Showing {formatNumber(visibleCount)} of {formatNumber(lines.length)}{' '}
                scheduled lines
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
