/**
 * @module updater
 * @description Auto-update lifecycle via electron-updater.
 *
 * Publishes update status events to the renderer via `latch:updater-status`.
 * The renderer can trigger check / download / install via IPC handlers
 * registered in index.ts.
 *
 * Relies on the `publish` config in package.json (GitHub Releases provider)
 * and the `app-update.yml` that electron-builder generates at build time.
 */

import { autoUpdater, UpdateInfo } from 'electron-updater'
import type { BrowserWindow } from 'electron'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  version: string | null
  progress: number | null
  error: string | null
}

let state: UpdateState = {
  status: 'idle',
  version: null,
  progress: null,
  error: null,
}

let win: BrowserWindow | null = null

/** Send the current update state to the renderer. */
function emit(): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('latch:updater-status', { ...state })
}

function setState(patch: Partial<UpdateState>): void {
  Object.assign(state, patch)
  emit()
}

/**
 * Initialise the auto-updater. Call once after the BrowserWindow is created.
 * Does NOT auto-download — the user triggers download from the UI.
 */
export function initUpdater(mainWindow: BrowserWindow): void {
  win = mainWindow

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking', error: null })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setState({ status: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    setState({ status: 'not-available' })
  })

  autoUpdater.on('download-progress', (progress: { percent: number }) => {
    setState({
      status: 'downloading',
      progress: Math.round(progress.percent),
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setState({ status: 'downloaded', version: info.version, progress: 100 })
  })

  autoUpdater.on('error', (err: Error) => {
    setState({ status: 'error', error: err.message })
  })
}

/** Check for updates (does not download). */
export async function checkForUpdates(): Promise<UpdateState> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err: any) {
    setState({ status: 'error', error: err?.message ?? 'Check failed' })
  }
  return { ...state }
}

/** Download the available update. */
export async function downloadUpdate(): Promise<UpdateState> {
  try {
    setState({ status: 'downloading', progress: 0 })
    await autoUpdater.downloadUpdate()
  } catch (err: any) {
    setState({ status: 'error', error: err?.message ?? 'Download failed' })
  }
  return { ...state }
}

/** Quit and install the downloaded update. */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}

/** Return the current update state (no side effects). */
export function getUpdateState(): UpdateState {
  return { ...state }
}
