import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/**
 * One row in the suggestion list. Both kinds of row the report shows can be
 * suggested — a material or a load — because either can be searched from either
 * grouping: typing a material number in the load view finds the loads carrying
 * it, and typing a load number in the material view finds the materials on it.
 */
export type SearchSuggestion = {
  kind: 'material' | 'load'
  /** What picking it puts in the search box — the value that identifies one row. */
  value: string
  /** The identifier, shown in mono type. */
  label: string
  /** Name, route or PO shown beside the identifier. */
  detail: string
  /** Trailing note, e.g. how much of it is short. */
  note?: string
}

/**
 * The table's search box, with suggestions under it. The report is searched by
 * material number and load number far more than by anything else, and both are
 * long digit strings nobody remembers whole — so as soon as a few digits are
 * typed the box offers what matches, tagged with which kind of row it is, and
 * picking one searches for that exact number.
 *
 * The input stays free text: a suggestion is a shortcut, not a constraint, so a
 * query that matches a plant or a ship-to still works with the list ignored.
 */
export function ReportSearch({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  id: string
  value: string
  onChange: (next: string) => void
  /** Already ranked, merged and capped by the caller. */
  suggestions: readonly SearchSuggestion[]
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = `${id}-suggestions`
  const inputRef = useRef<HTMLInputElement>(null)

  // The list is rebuilt on every keystroke, so an index into the old one would
  // point at the wrong row.
  useEffect(() => {
    setActive(-1)
  }, [suggestions])

  const visible = open && suggestions.length > 0

  function select(suggestion: SearchSuggestion) {
    // The number is what identifies the row; searching for the name would keep
    // every material that shares a word with it.
    onChange(suggestion.value)
    setOpen(false)
    setActive(-1)
    inputRef.current?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false)
      setActive(-1)
      return
    }
    if (suggestions.length === 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActive((i) => (i + 1) % suggestions.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
      return
    }
    if (event.key === 'Enter' && visible && active >= 0) {
      // Only intercept Enter when a suggestion is actually highlighted —
      // otherwise the typed query stands on its own.
      event.preventDefault()
      select(suggestions[active])
    }
  }

  return (
    <div
      className="relative"
      // Clicking a suggestion moves focus inside this wrapper, so the list only
      // closes when focus leaves it altogether.
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setOpen(false)
        setActive(-1)
      }}
    >
      <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        ref={inputRef}
        id={id}
        type="search"
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          visible && active >= 0 ? `${listId}-${active}` : undefined
        }
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="text-sm border border-gray-200 rounded-lg pl-9 pr-3 py-2 w-56 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
      />
      {visible && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 left-0 w-80 max-h-64 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg py-1"
        >
          {suggestions.map((suggestion, i) => (
            <li key={`${suggestion.kind}:${suggestion.value}:${i}`} role="none">
              <button
                type="button"
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                // The input keeps focus on mousedown, so the click doesn't have
                // to race the blur that would close the list.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => select(suggestion)}
                className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 ${
                  i === active ? 'bg-gray-100' : 'hover:bg-gray-50'
                }`}
              >
                {/* Which kind of row this is, because either can be suggested
                    from either grouping and the numbers look alike. */}
                <span
                  className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 shrink-0 ${
                    suggestion.kind === 'load'
                      ? 'bg-blue-50 text-blue-700'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {suggestion.kind === 'load' ? 'Load' : 'Mat'}
                </span>
                <span className="font-mono text-xs text-gray-900 shrink-0">
                  {suggestion.label}
                </span>
                <span className="text-xs text-gray-500 truncate">
                  {suggestion.detail}
                </span>
                {suggestion.note && (
                  <span className="text-xs text-gray-400 ml-auto shrink-0">
                    {suggestion.note}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
