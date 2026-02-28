/**
 * @module WelcomeScreen
 * @description Full-panel welcome/splash screen shown when no sessions exist.
 * Features an AuthKit-inspired grid background, mouse-tracking spotlight,
 * shimmer-animated title, ASCII-art patterned action cards, and staggered
 * entrance animations.
 */

import { useState, useCallback, useRef } from 'react'
import { Terminal, FolderOpen, Lock, Lightning } from '@phosphor-icons/react'
import { useAppStore } from '../store/useAppStore'

export default function WelcomeScreen() {
  const { createSession, setActiveView, setPendingProjectDir } = useAppStore()
  const [exiting, setExiting] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0.5, y: 0.5 })
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setMousePos({
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    })
  }, [])

  const handleStartBuilding = () => {
    setExiting(true)
    setTimeout(() => {
      createSession('Session 1')
    }, 350)
  }

  const handleOpenProject = async () => {
    const result = await window.latch?.pickDirectory?.()
    if (result && !result.cancelled && result.filePath) {
      setPendingProjectDir(result.filePath)
      setExiting(true)
      setTimeout(() => {
        createSession('Session 1')
      }, 350)
    }
  }

  const handleOpenPolicies = () => {
    setActiveView('policies')
  }

  const handleBrowseSkills = () => {
    setActiveView('skills')
  }

  return (
    <div
      ref={containerRef}
      className={`welcome-screen${exiting ? ' welcome-exit' : ''}`}
      onMouseMove={handleMouseMove}
      style={{
        '--mouse-x': mousePos.x,
        '--mouse-y': mousePos.y,
      } as React.CSSProperties}
    >
      {/* ── Grid background ──────────────────────────────────────────── */}
      <div className="welcome-grid" />

      {/* ── Mouse-tracking spotlight ─────────────────────────────────── */}
      <div className="welcome-spotlight" />

      {/* ── Top-down light beam ──────────────────────────────────────── */}
      <div className="welcome-ambient">
        <div className="welcome-beam" />
      </div>

      {/* ── Content ──────────────────────────────────────────────────── */}
      <div className="welcome-content">
        <pre className="welcome-ascii-title">{`██╗      █████╗ ████████╗ ██████╗██╗  ██╗
██║     ██╔══██╗╚══██╔══╝██╔════╝██║  ██║
██║     ███████║   ██║   ██║     ███████║
██║     ██╔══██║   ██║   ██║     ██╔══██║
███████╗██║  ██║   ██║   ╚██████╗██║  ██║
╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝`}</pre>

        <p className="welcome-tagline">
          Run any agent. Govern everything.
          <span className="welcome-blink">_</span>
        </p>

        {/* ── Action cards ─────────────────────────────────────────── */}
        <div className="welcome-cards">
          <button className="welcome-card" onClick={handleStartBuilding}>
            <Terminal className="welcome-card-icon" weight="light" />
            <span className="welcome-card-label">New Session</span>
            <span className="welcome-card-shortcut"><kbd>&#8984;</kbd><kbd>N</kbd></span>
          </button>

          <button className="welcome-card" onClick={handleOpenProject}>
            <FolderOpen className="welcome-card-icon" weight="light" />
            <span className="welcome-card-label">Open Project</span>
            <span className="welcome-card-shortcut"><kbd>&#8984;</kbd><kbd>O</kbd></span>
          </button>

          <button className="welcome-card" onClick={handleOpenPolicies}>
            <Lock className="welcome-card-icon" weight="light" />
            <span className="welcome-card-label">Policies</span>
            <span className="welcome-card-shortcut"><kbd>&#8984;</kbd><kbd>P</kbd></span>
          </button>

          <button className="welcome-card" onClick={handleBrowseSkills}>
            <Lightning className="welcome-card-icon" weight="light" />
            <span className="welcome-card-label">Skills</span>
            <span className="welcome-card-shortcut"><kbd>&#8984;</kbd><kbd>K</kbd></span>
          </button>
        </div>
      </div>
    </div>
  )
}
