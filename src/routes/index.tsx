import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
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
import { FileUp, AlertTriangle, CheckCircle2, TrendingUp } from 'lucide-react'
import { getVarianceData, uploadReport } from '../server/reports.functions'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend)

export const Route = createFileRoute('/')({
  component: Home,
  loader: async () => getVarianceData(),
})

const SLOT_COLORS = [
  'rgba(59, 130, 246, 0.75)',
  'rgba(16, 185, 129, 0.75)',
  'rgba(245, 158, 11, 0.75)',
]

const DEFAULT_LABELS = ['Report A', 'Report B', 'Report C']

function formatNumber(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function Home() {
  const router = useRouter()
  const data = Route.useLoaderData()
  const [pending, setPending] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reportsBySlot = [1, 2, 3].map(
    (slot) => data.reports.find((r) => r.slot === slot) ?? null,
  )

  async function handleFile(slot: number, file: File) {
    setPending(slot)
    setError(null)
    try {
      const csvText = await file.text()
      const label = file.name.replace(/\.csv$/i, '') || DEFAULT_LABELS[slot - 1]
      await uploadReport({ data: { slot, label, csvText } })
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to process report')
    } finally {
      setPending(null)
    }
  }

  const chartData = {
    labels: data.variance.map((row) => row.category),
    datasets: reportsBySlot.map((report, i) => ({
      label: report?.label ?? DEFAULT_LABELS[i],
      data: data.variance.map((row) => row.values[i] ?? 0),
      backgroundColor: SLOT_COLORS[i],
      borderRadius: 4,
    })),
  }

  const readyCount = reportsBySlot.filter(Boolean).length
  const topVariance = data.variance[0]

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Report Variance Analysis
        </h1>
        <p className="text-gray-500 mb-8">
          Upload three reports (CSV, formatted as <code>category,amount</code>{' '}
          per line) to compare line items and surface variances between them.
        </p>

        {/* Upload slots */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
          {[0, 1, 2].map((i) => {
            const slot = i + 1
            const report = reportsBySlot[i]
            return (
              <div
                key={slot}
                className="bg-white rounded-xl shadow-sm p-6 flex flex-col gap-3"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: SLOT_COLORS[i] }}
                  />
                  <p className="font-semibold text-gray-900">
                    Report {slot} slot
                  </p>
                </div>
                {report ? (
                  <div className="flex items-center gap-2 text-sm text-emerald-600">
                    <CheckCircle2 className="w-4 h-4" />
                    <span className="truncate">{report.label}</span>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">No report uploaded yet</p>
                )}
                <label className="mt-auto inline-flex items-center justify-center gap-2 cursor-pointer bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors">
                  <FileUp className="w-4 h-4" />
                  {pending === slot
                    ? 'Uploading…'
                    : report
                      ? 'Replace CSV'
                      : 'Upload CSV'}
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    disabled={pending !== null}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleFile(slot, file)
                      e.target.value = ''
                    }}
                  />
                </label>
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

        {readyCount < 2 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center text-gray-400">
            Upload at least two reports to see a variance comparison.
          </div>
        ) : (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
              <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
                <div className="bg-blue-500 p-3 rounded-lg">
                  <TrendingUp className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Categories compared</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {data.variance.length}
                  </p>
                </div>
              </div>
              <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
                <div className="bg-amber-500 p-3 rounded-lg">
                  <AlertTriangle className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Largest variance</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {topVariance ? formatNumber(topVariance.variance) : '—'}
                  </p>
                  {topVariance && (
                    <p className="text-sm text-gray-500 truncate max-w-[16rem]">
                      {topVariance.category}
                    </p>
                  )}
                </div>
              </div>
              <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
                <div className="bg-emerald-500 p-3 rounded-lg">
                  <CheckCircle2 className="w-6 h-6 text-white" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Reports loaded</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {readyCount} / 3
                  </p>
                </div>
              </div>
            </div>

            {/* Chart */}
            <div className="bg-white rounded-xl shadow-sm p-6 mb-8">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                Side-by-side comparison
              </h2>
              <Bar
                data={chartData}
                options={{
                  responsive: true,
                  plugins: { legend: { position: 'bottom' } },
                  scales: { y: { beginAtZero: true } },
                }}
              />
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl shadow-sm p-6 overflow-x-auto">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                Variance by category
              </h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-4">Category</th>
                    {reportsBySlot.map((report, i) => (
                      <th key={i} className="py-2 pr-4">
                        {report?.label ?? DEFAULT_LABELS[i]}
                      </th>
                    ))}
                    <th className="py-2 pr-4">Variance</th>
                    <th className="py-2">Variance %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.variance.map((row) => {
                    const flagged = row.variancePct >= 10
                    return (
                      <tr
                        key={row.category}
                        className="border-b border-gray-50 last:border-0"
                      >
                        <td className="py-2 pr-4 font-medium text-gray-900">
                          {row.category}
                        </td>
                        {row.values.map((v, i) => (
                          <td key={i} className="py-2 pr-4 text-gray-600">
                            {v === null ? '—' : formatNumber(v)}
                          </td>
                        ))}
                        <td className="py-2 pr-4 text-gray-600">
                          {formatNumber(row.variance)}
                        </td>
                        <td
                          className={`py-2 font-semibold ${
                            flagged ? 'text-red-600' : 'text-emerald-600'
                          }`}
                        >
                          {formatNumber(row.variancePct)}%
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
