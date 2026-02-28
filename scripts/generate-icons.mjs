#!/usr/bin/env node
/**
 * generate-icons.mjs
 *
 * Converts build/icon.svg into all platform icon assets:
 *   - build/icon.png        (1024×1024 master raster)
 *   - build/icon.icns        (macOS — via iconutil)
 *   - build/icon.ico         (Windows — raw ICO container)
 *   - build/icons/*.png      (Linux — individual sizes)
 *
 * Prerequisites:
 *   npm install --save-dev sharp
 *   macOS: iconutil is built-in
 *
 * Usage:
 *   node scripts/generate-icons.mjs
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BUILD = join(ROOT, 'build')
const SVG = readFileSync(join(BUILD, 'icon.svg'))

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resize SVG to a square PNG at the given pixel size. */
async function rasterize(size) {
  return sharp(SVG, { density: Math.round((72 * size) / 1024) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
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
  console.log('Generating Latch Desktop icons from build/icon.svg …')

  await generateMasterPng()
  await generateMacIcons()
  await generateWindowsIcon()
  await generateLinuxIcons()

  console.log('\n✅ All icons generated.\n')
  console.log('Files:')
  console.log('  build/icon.png     — 1024×1024 master raster')
  console.log('  build/icon.icns    — macOS app icon')
  console.log('  build/icon.ico     — Windows app icon')
  console.log('  build/icons/*.png  — Linux icon set')
}

main().catch((err) => {
  console.error('❌ Icon generation failed:', err.message)
  process.exit(1)
})
