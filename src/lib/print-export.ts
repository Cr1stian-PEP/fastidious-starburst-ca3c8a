// Browser side of the export: the PDF path and the file download. The PDF is
// produced by handing the browser a print-ready document — every platform's
// print dialog can save one, and it keeps the app free of a PDF renderer whose
// output would have to be kept in step with the tables by hand.

import type { ExportCell, ExportDocument } from './report-export.js'

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function downloadBase64(
  base64: string,
  fileName: string,
  mimeType: string = XLSX_MIME,
) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderCell(cell: ExportCell) {
  if (typeof cell !== 'number') return `<td>${escapeHtml(cell)}</td>`
  // A shortfall reads red on the page, so it reads red on the printout too.
  const cls = cell < 0 ? 'num neg' : 'num'
  return `<td class="${cls}">${escapeHtml(cell.toLocaleString())}</td>`
}

export function renderExportHtml(doc: ExportDocument) {
  const meta = doc.meta
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join('')

  const tables = doc.tables
    .map((table) => {
      if (table.rows.length === 0) {
        return `<section><h2>${escapeHtml(table.name)}</h2><p class="empty">No rows.</p></section>`
      }
      const head = table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')
      const body = table.rows
        .map((row) => `<tr>${row.map(renderCell).join('')}</tr>`)
        .join('')
      return `<section>
  <h2>${escapeHtml(table.name)} <span class="count">${table.rows.length.toLocaleString()} rows</span></h2>
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</section>`
    })
    .join('')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(doc.fileName)}</title>
<style>
  /* Landscape: the variance tables are wide, and a portrait page drops columns
     off the edge or shrinks them past reading size. */
  @page { size: landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    color: #111827;
    margin: 0;
    font-size: 10px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 {
    font-size: 12px;
    margin: 0 0 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid #d1d5db;
  }
  h2 .count { font-weight: 400; color: #6b7280; font-size: 10px; }
  dl { display: flex; flex-wrap: wrap; gap: 4px 24px; margin: 0 0 16px; }
  dt { color: #6b7280; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; }
  dd { margin: 0; font-weight: 600; }
  section { margin-bottom: 20px; break-inside: auto; }
  table { width: 100%; border-collapse: collapse; }
  /* Repeat the header on every printed page of a long table. */
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th {
    text-align: left;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #6b7280;
    border-bottom: 1px solid #9ca3af;
    padding: 3px 6px 3px 0;
  }
  td { padding: 3px 6px 3px 0; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* Without this the red drops out of most browsers' print output. */
  td.neg { color: #b91c1c; font-weight: 600; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .empty { color: #6b7280; }
</style>
</head>
<body>
  <h1>${escapeHtml(doc.title)}</h1>
  <dl>${meta}</dl>
  ${tables}
</body>
</html>`
}

/**
 * Opens the browser's print dialog on a rendered copy of the export, where
 * "Save as PDF" produces the file. Rendered in an off-screen iframe rather than
 * a new window so a popup blocker can't swallow it.
 */
export function printExportDocument(doc: ExportDocument) {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;'

  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    frame.remove()
  }

  frame.onload = () => {
    const win = frame.contentWindow
    if (!win) {
      remove()
      return
    }
    // Some browsers return from print() immediately and only fire afterprint
    // when the dialog closes; tearing the iframe down early cancels the job.
    win.addEventListener('afterprint', remove)
    win.focus()
    win.print()
    setTimeout(remove, 60_000)
  }

  frame.srcdoc = renderExportHtml(doc)
  document.body.appendChild(frame)
}
