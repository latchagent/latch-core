#!/usr/bin/env node
/**
 * generate-icons.mjs
 *
 * Generates all platform icon assets from the ASCII "LATCH" logo:
 *   - build/icon.svg         (generated SVG source)
 *   - build/icon.png         (1024×1024 master raster)
 *   - build/icon.icns        (macOS — via iconutil)
 *   - build/icon.ico         (Windows — raw ICO container)
 *   - build/icons/*.png      (Linux — individual sizes)
 *
 * The ASCII logo is converted to pixel-art rectangles in SVG, with the
 * app's signature white-to-grey gradient on a black background with
 * rounded corners (Apple squircle radius).
 *
 * Prerequisites:
 *   npm install --save-dev sharp
 *   macOS: iconutil is built-in
 *
 * Usage:
 *   node scripts/generate-icons.mjs
 */

import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BUILD = join(ROOT, 'build')

// ── ASCII logo → SVG generation ─────────────────────────────────────────────

const ASCII_LOGO = [
  '██╗      █████╗ ████████╗ ██████╗██╗  ██╗',
  '██║     ██╔══██╗╚══██╔══╝██╔════╝██║  ██║',
  '██║     ███████║   ██║   ██║     ███████║',
  '██║     ██╔══██║   ██║   ██║     ██╔══██║',
  '███████╗██║  ██║   ██║   ╚██████╗██║  ██║',
  '╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝',
]

const ICON_SIZE = 1024
const ICON_INSET = 80     // transparent padding around the shape (matches macOS sizing)
const SHAPE_SIZE = ICON_SIZE - 2 * ICON_INSET // 864 — the visible rounded rect
const CORNER_RADIUS = 190 // ~22% of SHAPE_SIZE
const TEXT_PADDING_X = 80  // horizontal padding for text inside the shape
const ROW_GAP = 4         // small gap between rows for line-spacing feel

/** Build an SVG string from the ASCII logo. */
function buildIconSvg() {
  // Find all █ positions
  const cells = []
  const maxCols = Math.max(...ASCII_LOGO.map(l => [...l].length))
  for (let row = 0; row < ASCII_LOGO.length; row++) {
    const chars = [...ASCII_LOGO[row]]
    for (let col = 0; col < chars.length; col++) {
      if (chars[col] === '█') {
        cells.push({ row, col })
      }
    }
  }

  // Cell sizing — fit within the inset shape with horizontal padding
  const cellW = Math.floor((SHAPE_SIZE - 2 * TEXT_PADDING_X) / maxCols)
  const cellH = Math.round(cellW * 1.45) // slightly taller than wide for block-letter feel
  const textW = maxCols * cellW
  const textH = ASCII_LOGO.length * cellH + (ASCII_LOGO.length - 1) * ROW_GAP
  // Center text within the shape (which is itself centered in the canvas)
  const offsetX = ICON_INSET + Math.round((SHAPE_SIZE - textW) / 2)
  const offsetY = ICON_INSET + Math.round((SHAPE_SIZE - textH) / 2)

  // Build SVG
  const rects = cells.map(({ row, col }) => {
    const x = offsetX + col * cellW
    const y = offsetY + row * (cellH + ROW_GAP)
    return `    <rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="url(#g)"/>`
  })

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}">
  <defs>
    <!-- Top-to-bottom gradient matching the welcome screen ASCII title -->
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.55"/>
    </linearGradient>

    <!-- Ambient glow behind the text -->
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="18"/>
    </filter>

    <!-- Rounded-corner clip (Apple squircle) -->
    <clipPath id="r">
      <rect x="${ICON_INSET}" y="${ICON_INSET}" width="${SHAPE_SIZE}" height="${SHAPE_SIZE}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}"/>
    </clipPath>
  </defs>

  <g clip-path="url(#r)">
    <!-- Background -->
    <rect x="${ICON_INSET}" y="${ICON_INSET}" width="${SHAPE_SIZE}" height="${SHAPE_SIZE}" fill="#000000"/>

    <!-- Glow layer -->
    <g opacity="0.07" filter="url(#glow)">
${rects.map(r => r.replace('fill="url(#g)"', 'fill="#ffffff"')).join('\n')}
    </g>

    <!-- Text pixels -->
${rects.join('\n')}
  </g>
</svg>
`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let SVG

/** Resize SVG to a square PNG at the given pixel size. */
async function rasterize(size) {
  return sharp(Buffer.from(SVG), { density: Math.round((72 * size) / ICON_SIZE) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

/** Write a PNG buffer to disk. */
async function writePng(filePath, size) {
  const buf = await rasterize(size)
  writeFileSync(filePath, buf)
  console.log(`  ✓ ${filePath.replace(ROOT + '/', '')}  (${size}×${size})`)
  return buf
}

/**
 * Build a Windows ICO file from an array of PNG buffers.
 * ICO format: 6-byte header + 16-byte directory entries + PNG image data.
 */
function buildIco(pngBuffers) {
  const count = pngBuffers.length
  const headerSize = 6
  const dirEntrySize = 16
  const dirSize = dirEntrySize * count
  let dataOffset = headerSize + dirSize

  // Header: reserved=0, type=1 (icon), count
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)      // reserved
  header.writeUInt16LE(1, 2)      // type = ICO
  header.writeUInt16LE(count, 4)  // image count

  const dirEntries = []
  const imageDataParts = []

  for (const png of pngBuffers) {
    // Parse PNG header for dimensions
    // PNG signature (8 bytes) + IHDR chunk (4 len + 4 type + 4 width + 4 height)
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)

    const entry = Buffer.alloc(dirEntrySize)
    entry.writeUInt8(width >= 256 ? 0 : width, 0)   // width (0 = 256)
    entry.writeUInt8(height >= 256 ? 0 : height, 1)  // height (0 = 256)
    entry.writeUInt8(0, 2)                            // color palette
    entry.writeUInt8(0, 3)                            // reserved
    entry.writeUInt16LE(1, 4)                         // color planes
    entry.writeUInt16LE(32, 6)                        // bits per pixel
    entry.writeUInt32LE(png.length, 8)                // image data size
    entry.writeUInt32LE(dataOffset, 12)               // offset to image data

    dirEntries.push(entry)
    imageDataParts.push(png)
    dataOffset += png.length
  }

  return Buffer.concat([header, ...dirEntries, ...imageDataParts])
}

// ── macOS .icns ───────────────────────────────────────────────────────────────

async function generateMacIcons() {
  console.log('\n📦 macOS (.icns)')

  const iconsetDir = join(BUILD, 'icon.iconset')
  if (existsSync(iconsetDir)) rmSync(iconsetDir, { recursive: true })
  mkdirSync(iconsetDir, { recursive: true })

  // macOS iconset requires these exact filenames
  const specs = [
    { name: 'icon_16x16.png', size: 16 },
    { name: 'icon_16x16@2x.png', size: 32 },
    { name: 'icon_32x32.png', size: 32 },
    { name: 'icon_32x32@2x.png', size: 64 },
    { name: 'icon_128x128.png', size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png', size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png', size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 },
  ]

  for (const { name, size } of specs) {
    await writePng(join(iconsetDir, name), size)
  }

  // Convert .iconset → .icns
  const icnsPath = join(BUILD, 'icon.icns')
  execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`)
  console.log(`  ✓ build/icon.icns`)

  // Clean up the .iconset directory
  rmSync(iconsetDir, { recursive: true })
}

// ── Windows .ico ──────────────────────────────────────────────────────────────

async function generateWindowsIcon() {
  console.log('\n📦 Windows (.ico)')

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngBuffers = []

  for (const size of sizes) {
    const buf = await rasterize(size)
    pngBuffers.push(buf)
    console.log(`  ✓ ico entry  (${size}×${size})`)
  }

  const ico = buildIco(pngBuffers)
  const icoPath = join(BUILD, 'icon.ico')
  writeFileSync(icoPath, ico)
  console.log(`  ✓ build/icon.ico  (${sizes.length} sizes, ${(ico.length / 1024).toFixed(0)} KB)`)
}

// ── Linux PNGs ────────────────────────────────────────────────────────────────

async function generateLinuxIcons() {
  console.log('\n📦 Linux (PNGs)')

  const iconsDir = join(BUILD, 'icons')
  if (existsSync(iconsDir)) rmSync(iconsDir, { recursive: true })
  mkdirSync(iconsDir, { recursive: true })

  const sizes = [16, 24, 32, 48, 64, 128, 256, 512]
  for (const size of sizes) {
    await writePng(join(iconsDir, `${size}x${size}.png`), size)
  }
}

// ── Master PNG ────────────────────────────────────────────────────────────────

async function generateMasterPng() {
  console.log('\n📦 Master PNG')
  await writePng(join(BUILD, 'icon.png'), 1024)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Generating Latch Desktop icons from ASCII logo …\n')

  // 1. Build SVG from ASCII art and write it
  SVG = buildIconSvg()
  const svgPath = join(BUILD, 'icon.svg')
  writeFileSync(svgPath, SVG)
  console.log(`  ✓ build/icon.svg  (generated from ASCII logo)`)

  // 2. Generate all platform assets
  await generateMasterPng()
  await generateMacIcons()
  await generateWindowsIcon()
  await generateLinuxIcons()

  console.log('\n✅ All icons generated.\n')
  console.log('Files:')
  console.log('  build/icon.svg     — generated SVG source')
  console.log('  build/icon.png     — 1024×1024 master raster')
  console.log('  build/icon.icns    — macOS app icon')
  console.log('  build/icon.ico     — Windows app icon')
  console.log('  build/icons/*.png  — Linux icon set')
}

main().catch((err) => {
  console.error('❌ Icon generation failed:', err.message)
  process.exit(1)
})
