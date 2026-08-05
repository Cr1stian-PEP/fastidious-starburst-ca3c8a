// Generates src/server/data/material-footprints.json from scripts/reference/Key.xlsx.
// Re-run with `node scripts/generate-footprints.mjs` whenever the key file is updated.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as XLSX from 'xlsx'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const keyPath = path.join(__dirname, 'reference', 'Key.xlsx')
const outPath = path.join(__dirname, '..', 'src', 'server', 'data', 'material-footprints.json')

const workbook = XLSX.read(readFileSync(keyPath))
const sheet = workbook.Sheets[workbook.SheetNames[0]]
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

// The key file is a "Master" list of material description sections; each section
// has a title row and a "DESCRIPTION, Material, FOOT_PRINT" header row before its
// data rows. Only rows whose Material column is numeric are real data.
// A footprint like "100X25X4" means 100 cases fit on a pallet, so only the
// first number matters for the cases -> pallets conversion.
const casesPerPallet = {}

for (const row of rows) {
  const material = String(row[1]).trim()
  if (!/^[0-9]{5,}$/.test(material)) continue

  const footprint = String(row[2]).trim()
  const match = footprint.match(/^([0-9]+)X/i)
  if (!match) continue

  casesPerPallet[material] = Number(match[1])
}

writeFileSync(outPath, JSON.stringify(casesPerPallet, null, 2) + '\n')
console.log(`Wrote ${Object.keys(casesPerPallet).length} material footprints to ${outPath}`)
