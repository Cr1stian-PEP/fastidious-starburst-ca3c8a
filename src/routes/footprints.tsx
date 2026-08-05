import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Layers,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react'
import { getFootprints, resetFootprint, saveFootprint } from '../server/reports.functions'
import { SortHeader } from '../components/sort-header'
import {
  filterAndSortFootprints,
  type FootprintFilter,
  type FootprintSortKey,
  type SortState,
} from '../lib/table-sort'

export const Route = createFileRoute('/footprints')({
  component: Footprints,
  loader: async () => getFootprints(),
})

const FILTERS: Array<{ value: FootprintFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'missing', label: 'Missing footprint' },
  { value: 'edited', label: 'Edited' },
]

const SOURCE_LABELS: Record<string, { label: string; className: string }> = {
  key: { label: 'Key file', className: 'bg-gray-100 text-gray-600' },
  override: { label: 'Edited', className: 'bg-amber-100 text-amber-700' },
  added: { label: 'Added', className: 'bg-emerald-100 text-emerald-700' },
}

function formatNumber(n: number) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function Footprints() {
  const router = useRouter()
  const rows = Route.useLoaderData()

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FootprintFilter>('all')
  const [sort, setSort] = useState<SortState<FootprintSortKey>>({
    key: 'material',
    dir: 'asc',
  })

  // Which row is being edited, and the raw text in its input. Kept as text so a
  // half-typed value isn't coerced to a number on every keystroke.
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const [newMaterial, setNewMaterial] = useState('')
  const [newCases, setNewCases] = useState('')

  const visible = useMemo(
    () => filterAndSortFootprints(rows, { query, filter, sort }),
    [rows, query, filter, sort],
  )

  const missingCount = rows.filter((r) => r.casesPerPallet === null).length
  const editedCount = rows.filter((r) => r.source !== 'key').length

  function flashSaved(material: string) {
    setSaved(material)
    setTimeout(() => setSaved((m) => (m === material ? null : m)), 1500)
  }

  async function commit(material: string, value: string) {
    const casesPerPallet = Number(value)
    if (!value.trim() || !Number.isFinite(casesPerPallet) || casesPerPallet <= 0) {
      setError(`“${value}” isn’t a valid cases-per-pallet value for ${material}.`)
      return
    }

    setBusy(material)
    setError(null)
    try {
      await saveFootprint({ data: { material, casesPerPallet } })
      await router.invalidate()
      setEditing(null)
      flashSaved(material)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save footprint')
    } finally {
      setBusy(null)
    }
  }

  async function reset(material: string) {
    setBusy(material)
    setError(null)
    try {
      await resetFootprint({ data: { material } })
      await router.invalidate()
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset footprint')
    } finally {
      setBusy(null)
    }
  }

  async function addNew(e: React.FormEvent) {
    e.preventDefault()
    const material = newMaterial.trim()
    if (!/^[0-9]+$/.test(material)) {
      setError('Material number must be digits only.')
      return
    }
    await commit(material, newCases)
    setNewMaterial('')
    setNewCases('')
  }

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

        <h1 className="text-3xl font-bold text-gray-900 mb-2">Pallet Footprints</h1>
        <p className="text-gray-500 mb-8 max-w-3xl">
          Cases per pallet for each material — the first number of the
          footprint, which is what converts case quantities to pallets in Pallet
          View. Values come from the footprint key file; anything you change or
          add here overrides it and is saved for everyone.
        </p>

        {/* Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
            <div className="bg-gray-900 p-3 rounded-lg">
              <Layers className="w-6 h-6 text-white" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Materials</p>
              <p className="text-2xl font-bold text-gray-900">{formatNumber(rows.length)}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
            <div className="bg-red-500 p-3 rounded-lg">
              <AlertTriangle className="w-6 h-6 text-white" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Missing a footprint</p>
              <p className="text-2xl font-bold text-gray-900">{formatNumber(missingCount)}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
            <div className="bg-amber-500 p-3 rounded-lg">
              <Check className="w-6 h-6 text-white" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Edited or added</p>
              <p className="text-2xl font-bold text-gray-900">{formatNumber(editedCount)}</p>
            </div>
          </div>
        </div>

        {/* Add a footprint */}
        <form
          onSubmit={addNew}
          className="bg-white rounded-xl shadow-sm p-6 mb-8 flex flex-wrap items-end gap-4"
        >
          <div>
            <label
              htmlFor="new-material"
              className="block text-xs font-medium text-gray-500 mb-1"
            >
              Material number
            </label>
            <input
              id="new-material"
              value={newMaterial}
              onChange={(e) => setNewMaterial(e.target.value)}
              inputMode="numeric"
              placeholder="300005186"
              className="text-sm font-mono border border-gray-200 rounded-lg px-3 py-2 w-44 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
          </div>
          <div>
            <label
              htmlFor="new-cases"
              className="block text-xs font-medium text-gray-500 mb-1"
            >
              Cases per pallet
            </label>
            <input
              id="new-cases"
              value={newCases}
              onChange={(e) => setNewCases(e.target.value)}
              inputMode="decimal"
              placeholder="40"
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 w-36 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
          </div>
          <button
            type="submit"
            disabled={busy !== null}
            className="inline-flex items-center gap-2 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add or update
          </button>
          <p className="text-xs text-gray-400">
            Entering a material that already has a footprint replaces its value.
          </p>
        </form>

        {error && (
          <div className="mb-8 flex items-center gap-2 bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-3 text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Table */}
        <div className="bg-white rounded-xl shadow-sm p-6 overflow-x-auto">
          <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
            <h2 className="text-lg font-semibold text-gray-900">Footprints by material</h2>
            <div className="flex items-center gap-3 flex-wrap">
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
              <div className="inline-flex rounded-lg bg-gray-100 p-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setFilter(f.value)}
                    aria-pressed={filter === f.value}
                    className={`text-sm font-medium rounded-md px-3 py-1.5 transition-colors ${
                      filter === f.value
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-500 hover:text-gray-900'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
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
                  label="Cases per Pallet"
                  sortKey="casesPerPallet"
                  state={sort}
                  onChange={setSort}
                  className="py-2 pr-4"
                />
                <SortHeader
                  label="Source"
                  sortKey="source"
                  state={sort}
                  onChange={setSort}
                  className="py-2 pr-4"
                />
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const isEditing = editing === row.material
                const source = SOURCE_LABELS[row.source] ?? SOURCE_LABELS.key
                const isBusy = busy === row.material
                return (
                  <tr
                    key={row.material}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50"
                  >
                    <td className="py-2 pr-4 font-mono text-gray-900">{row.material}</td>
                    <td className="py-2 pr-4 text-gray-700">{row.materialName || '—'}</td>
                    <td className="py-2 pr-4">
                      {isEditing ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commit(row.material, draft)
                            if (e.key === 'Escape') setEditing(null)
                          }}
                          inputMode="decimal"
                          className="text-sm border border-gray-300 rounded px-2 py-1 w-28 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(row.material)
                            setDraft(row.casesPerPallet?.toString() ?? '')
                            setError(null)
                          }}
                          className={`rounded px-2 py-1 -ml-2 hover:bg-gray-100 ${
                            row.casesPerPallet === null
                              ? 'text-gray-400 italic'
                              : 'text-gray-900 font-medium'
                          }`}
                          title="Click to edit"
                        >
                          {row.casesPerPallet === null
                            ? 'Not set'
                            : formatNumber(row.casesPerPallet)}
                        </button>
                      )}
                      {saved === row.material && (
                        <span className="ml-2 text-xs text-emerald-600">Saved</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <span
                        className={`text-xs font-medium rounded-full px-2 py-0.5 ${source.className}`}
                      >
                        {source.label}
                      </span>
                      {row.source === 'override' && row.keyValue !== null && (
                        <span className="ml-2 text-xs text-gray-400">
                          key: {formatNumber(row.keyValue)}
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        {isEditing && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => commit(row.material, draft)}
                            className="inline-flex items-center gap-1 bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white text-xs font-medium rounded-md px-2.5 py-1.5"
                          >
                            <Check className="w-3.5 h-3.5" />
                            {isBusy ? 'Saving…' : 'Save'}
                          </button>
                        )}
                        {row.source !== 'key' && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => reset(row.material)}
                            title={
                              row.keyValue === null
                                ? 'Remove this added footprint'
                                : `Revert to the key file value (${formatNumber(row.keyValue)})`
                            }
                            className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-900 rounded-md px-2 py-1.5 hover:bg-gray-100 disabled:opacity-50"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            {row.keyValue === null ? 'Remove' : 'Revert'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {visible.length === 0 && (
            <p className="text-sm text-gray-400 py-8 text-center">
              {filter === 'missing'
                ? 'Every material in view has a footprint.'
                : filter === 'edited'
                  ? 'No footprints have been edited or added yet.'
                  : `No materials match “${query}”.`}
            </p>
          )}

          <p className="text-xs text-gray-400 mt-3">
            Showing {formatNumber(visible.length)} of {formatNumber(rows.length)} materials
            {filter === 'missing' && ' (missing a footprint)'}
            {filter === 'edited' && ' (edited or added)'}
          </p>
        </div>
      </div>
    </div>
  )
}
