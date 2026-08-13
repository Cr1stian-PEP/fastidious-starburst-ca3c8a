import { Boxes, CheckCircle2, Truck, TrendingDown } from 'lucide-react'
import { formatNumber } from '../lib/units'

/**
 * The allocation read-out that sits above the variance table: what the loads in
 * the current view can draw on, what they ask for, how many of them the
 * allocation covered, and how many are still short.
 *
 * It reads the view rather than the whole report — searching a material narrows
 * it to that material's own share of the loads that want it, so it always
 * answers a question about the rows on screen. The counts come from the same
 * allocation the load table renders, so "fully allocated" here means exactly
 * what a non-negative variance means there. The threshold widens it to loads
 * allocated at least a given percentage of what they asked for, which is the
 * unit-free way to say it: a percentage means the same thing on a one-pallet
 * load and a forty-pallet one, in cases or in pallets.
 */
export function AllocationSummaryPanel({
  availableText,
  availableNote,
  neededText,
  neededNote,
  toProduceText,
  awaitingProduction,
  allocatedPercent,
  loads,
  allocated,
  withinTolerance,
  short,
  shortText,
  threshold,
  onThresholdChange,
  query,
  shortfallsOnly,
  deliveriesOnly,
  productionOnly,
  onHandOnly,
  scopeNote,
}: {
  /** Stock the allocation left for these loads, formatted in the page's units. */
  availableText: string
  /** The "+ N cs with no footprint" note, when pallet view leaves some behind. */
  availableNote: string
  /** Total demand across the view, already formatted in the page's units. */
  neededText: string
  neededNote: string
  /** How much of what is available has still to be produced, in the page's units. */
  toProduceText: string
  /** Loads counting on stock that isn't made yet. */
  awaitingProduction: number
  /** Demand-weighted coverage across the view, as a percentage. */
  allocatedPercent: number
  loads: number
  allocated: number
  withinTolerance: number
  short: number
  /** How much the short loads are short, formatted in the page's units. */
  shortText: string
  /** Percentage of its demand a load must be allocated to count as covered. */
  threshold: number
  onThresholdChange: (next: number) => void
  /** What the table is filtered to, echoed so the figures can't be misread. */
  query: string
  shortfallsOnly: boolean
  /** By-material view only: the table is down to materials some load asks for. */
  deliveriesOnly: boolean
  /** By-material view only: the table is down to materials being produced. */
  productionOnly: boolean
  /** By-load view only: the allocation is running on finished stock alone. */
  onHandOnly: boolean
  /** One sentence naming exactly what these figures cover. */
  scopeNote: string
}) {
  const allocatedShare = loads > 0 ? Math.round((allocated / loads) * 100) : 0
  const trimmedQuery = query.trim()

  return (
    <section className="mb-5 rounded-xl border border-gray-100 bg-gray-50/70 p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Load allocation</h3>
          <p className="text-xs text-gray-400 mt-0.5 max-w-xl">
            Stock is drawn down in ship-date order, so a load counts as allocated
            only once enough of every material on it is left for it.{' '}
            {onHandOnly
              ? 'Scheduled production is excluded here: these are finished goods only.'
              : 'Finished goods go out first; anything a load has to reach into the production schedule for is flagged as still to be produced.'}
          </p>
          {/* The figures follow the search and the shortfalls filter, so both are
              named here rather than left to be inferred from the rows below. */}
          <div className="flex items-center gap-2 flex-wrap mt-2">
            {trimmedQuery && (
              <span className="inline-flex items-center text-xs font-medium bg-white text-gray-700 border border-gray-200 rounded-full px-2.5 py-0.5">
                Search “{trimmedQuery}”
              </span>
            )}
            {shortfallsOnly && (
              <span className="inline-flex items-center text-xs font-medium bg-red-50 text-red-700 border border-red-100 rounded-full px-2.5 py-0.5">
                Shortfalls only
              </span>
            )}
            {deliveriesOnly && (
              <span className="inline-flex items-center text-xs font-medium bg-amber-50 text-amber-700 border border-amber-100 rounded-full px-2.5 py-0.5">
                With delivery lines only
              </span>
            )}
            {productionOnly && (
              <span className="inline-flex items-center text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100 rounded-full px-2.5 py-0.5">
                Being produced only
              </span>
            )}
            {onHandOnly && (
              <span className="inline-flex items-center text-xs font-medium bg-gray-900 text-white border border-gray-900 rounded-full px-2.5 py-0.5">
                On hand only
              </span>
            )}
            <span className="text-xs text-gray-400">{scopeNote}</span>
          </div>
        </div>
        <div>
          <label
            htmlFor="allocation-threshold"
            className="block text-xs font-medium text-gray-500 mb-1"
          >
            Fully allocated at
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="allocation-threshold"
              type="number"
              min={0}
              max={100}
              step={1}
              value={threshold}
              onChange={(e) => {
                const next = Number(e.target.value)
                // An empty box reads as NaN; treat it as the strict default
                // rather than as 0%, which would call every load allocated.
                if (!Number.isFinite(next)) {
                  onThresholdChange(100)
                  return
                }
                onThresholdChange(Math.min(100, Math.max(0, next)))
              }}
              title="A load allocated at least this share of what it asked for counts as fully allocated."
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-20 bg-white focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
            <span className="text-sm text-gray-500">% or more</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Boxes className="w-3.5 h-3.5 text-emerald-500" />
            Available for these loads
          </div>
          <p className="text-xl font-bold text-gray-900 mt-1">{availableText}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {[
              availableNote,
              loads === 0
                ? 'nothing in this view'
                : `${formatNumber(allocatedPercent)}% of what is needed`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {/* Cases that are only available because the schedule is going to
              make them aren't on the floor, so the tile says how much of the
              figure above is still to come. */}
          {awaitingProduction > 0 && (
            <p className="text-xs font-medium text-blue-600 mt-1">
              includes {toProduceText} to be produced · {formatNumber(awaitingProduction)}{' '}
              load{awaitingProduction === 1 ? '' : 's'} waiting on it
            </p>
          )}
        </div>

        <div className="bg-white rounded-lg px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Truck className="w-3.5 h-3.5 text-amber-500" />
            Needed for loads
          </div>
          <p className="text-xl font-bold text-gray-900 mt-1">{neededText}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {[neededNote, `across ${formatNumber(loads)} load${loads === 1 ? '' : 's'}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>

        <div className="bg-white rounded-lg px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            Loads fully allocated
          </div>
          <p className="text-xl font-bold text-gray-900 mt-1">
            {formatNumber(allocated)}
            <span className="text-sm font-medium text-gray-400">
              {' '}
              of {formatNumber(loads)}
            </span>
          </p>
          {/* One glance at how much of the book is covered. */}
          <div className="h-1.5 rounded-full bg-gray-100 mt-2 overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${allocatedShare}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {loads === 0
              ? 'nothing to allocate in this view'
              : `${allocatedShare}% of loads${
                  withinTolerance > 0
                    ? ` · ${formatNumber(withinTolerance)} at ${formatNumber(threshold)}%+`
                    : ''
                }`}
          </p>
        </div>

        <div className="bg-white rounded-lg px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <TrendingDown className="w-3.5 h-3.5 text-red-500" />
            Loads short
          </div>
          <p
            className={`text-xl font-bold mt-1 ${
              short > 0 ? 'text-red-600' : 'text-gray-900'
            }`}
          >
            {formatNumber(short)}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {short > 0
              ? `short by ${shortText}`
              : loads === 0
                ? 'no loads in this view'
                : 'every load is covered'}
          </p>
        </div>
      </div>
    </section>
  )
}
