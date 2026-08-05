import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { nextSort, type SortState } from '../lib/table-sort'

// Excel-style column header: always shows a sort affordance, and clicking it
// sorts by that column ascending, or flips the direction if it is already the
// active column.
export function SortHeader<K extends string>({
  label,
  sortKey,
  state,
  onChange,
  className = '',
  dense = false,
}: {
  label: string
  sortKey: K
  state: SortState<K>
  onChange: (next: SortState<K>) => void
  className?: string
  dense?: boolean
}) {
  const active = state.key === sortKey
  const Icon = !active ? ArrowUpDown : state.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th
      className={className}
      aria-sort={active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onChange(nextSort(state, sortKey))}
        title={`Sort by ${label}`}
        className={`group inline-flex items-center gap-1 text-left hover:text-gray-900 transition-colors ${
          active ? 'text-gray-900 font-semibold' : ''
        }`}
      >
        {label}
        <Icon
          className={`${dense ? 'w-3 h-3' : 'w-3.5 h-3.5'} shrink-0 ${
            active ? 'text-gray-900' : 'text-gray-300 group-hover:text-gray-500'
          }`}
        />
      </button>
    </th>
  )
}
