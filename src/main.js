'use strict'

/**
 * dsh-desktop (WSL 适配版) — Electron 壳，连接 WSL 中已有的 DeepSeek Harness Web UI。
 *
 * 与原版区别：
 *   - 不尝试在本地启动/管理 dsh 服务（dsh 在 WSL 中运行）
 *   - 启动时检测 localhost:3080 是否可达，不可达则提示用户启动 WSL 中的 dsh
 *   - 移除环境检测、引导安装、dsh 进程管理等功能
 *   - 保留：独立窗口、系统托盘、选区截图、会话管理、更新检查
 */

const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage, ipcMain, desktopCapturer, clipboard, screen } = require('electron')
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const DEFAULT_PORT = 3080
const POLL_INTERVAL_MS = 500
const LOG_PREFIX = '[dsh-desktop-wsl]'

/** 解析端口：优先命令行 --port <n>，否则用默认值。 */
function resolvePort() {
  const idx = process.argv.indexOf('--port')
  if (idx !== -1 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1])
    if (Number.isInteger(n) && n > 0 && n < 65536) return n
    console.warn(LOG_PREFIX, `invalid --port value "${process.argv[idx + 1]}", fallback to ${DEFAULT_PORT}`)
  }
  return DEFAULT_PORT
}

let mainWindow = null
let tray = null
let isQuitting = false
let sessionsWin = null
let shotWindow = null
let pendingShot = null

/* ------------------------------------------------------------------ *
 * 工具：日志
 * ------------------------------------------------------------------ */

function log(...args) {
  console.log(LOG_PREFIX, ...args)
}

function shotLog(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}`
    console.log('[shot]', ...args)
    fs.appendFileSync(path.join(os.homedir(), '.dsh', 'logs', 'screenshot.log'), line + '\n')
  } catch { /* 忽略日志错误 */ }
}

/* ------------------------------------------------------------------ *
 * 自动更新检查
 * ------------------------------------------------------------------ */

const REPO = 'luminus-xt/dsh-desktop'
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const UPDATE_CHECK_TIMEOUT_MS = 10_000

function fetchJson(url) {
  return new Promise((resolve) => {
    const attempt = (rejectUnauthorized) => {
      const req = https.get(
        url,
        { headers: { 'User-Agent': 'dsh-desktop-update-check', Accept: 'application/vnd.github+json' }, timeout: UPDATE_CHECK_TIMEOUT_MS, rejectUnauthorized },
        (res) => {
          if (res.statusCode !== 200) { res.resume(); resolve(null); return }
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (d) => (body += d))
          res.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve(null) } })
        }
      )
      req.on('timeout', () => req.destroy())
      req.on('error', () => { if (rejectUnauthorized) attempt(false); else resolve(null) })
    }
    attempt(true)
  })
}

function parseVersion(v) {
  if (typeof v !== 'string') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function isNewer(a, b) {
  const pa = parseVersion(a); const pb = parseVersion(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i] }
  return false
}

async function checkForUpdates() {
  const current = app.getVersion()
  try {
    const release = await fetchJson(RELEASES_URL)
    if (!release) { log('update check: no release data'); return }
    const latest = release.tag_name
    log(`update check: current=${current} latest=${latest}`)
    if (!isNewer(latest, current)) return
    const name = release.name && release.name !== latest ? `「${release.name}」` : ''
    const detail = (release.body || '').split('\n').slice(0, 6).join('\n').trim()
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'info', title: '发现新版本',
      message: `DeepSeek Harness Desktop 有新版本可用（${latest} ${name}）`,
      detail: detail ? `更新内容：\n${detail}\n\n当前版本：${current}` : `当前版本：${current}`,
      buttons: ['前往下载', '以后再说'], defaultId: 0, cancelId: 1, noLink: true,
    })
    if (response === 0) shell.openExternal(RELEASES_PAGE)
  } catch (e) { log('update check failed:', e && e.message) }
}

/* ------------------------------------------------------------------ *
 * 工具：探测 HTTP 服务
 * ------------------------------------------------------------------ */

function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => { res.resume(); resolve(true) })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

/* ------------------------------------------------------------------ *
 * 会话管理
 * ------------------------------------------------------------------ */

function sessionsRoot() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions')
}

function decodeWorkspaceName(name) {
  let s = name
  if (s.startsWith('--')) s = s.slice(2)
  if (s.endsWith('--')) s = s.slice(0, -2)
  s = s.replace(/-/g, '\\')
  s = s.replace(/^C\\/, 'C:\\')
  return s
}

function listSessions() {
  const root = sessionsRoot()
  const list = []
  if (!fs.existsSync(root)) return list
  const workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const ws of workspaces) {
    const wsPath = path.join(root, ws.name)
    const sDirs = fs.readdirSync(wsPath, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('session-'))
    for (const s of sDirs) {
      const sPath = path.join(wsPath, s.name)
      const stat = fs.statSync(sPath)
      let sizeBytes = 0
      const walk = (dir) => {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, f.name)
          if (f.isDirectory()) walk(fp)
          else sizeBytes += fs.statSync(fp).size
        }
      }
      try { walk(sPath) } catch { /* ignore */ }
      list.push({ id: s.name, workspace: decodeWorkspaceName(ws.name), modified: stat.mtimeMs, sizeKB: Math.round(sizeBytes / 1024) })
    }
  }
  return list.sort((a, b) => b.modified - a.modified)
}

function deleteSession(id) {
  const root = sessionsRoot()
  if (!fs.existsSync(root) || !/^session-[0-9a-f-]+$/i.test(id)) return { ok: false, error: '非法会话 ID' }
  const workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const ws of workspaces) {
    const target = path.join(root, ws.name, id)
    if (fs.existsSync(target)) {
      try { fs.rmSync(target, { recursive: true, force: true }); log(`deleted session ${id} (${ws.name})`); return { ok: true } }
      catch (e) { return { ok: false, error: e.message } }
    }
  }
  return { ok: false, error: '未找到该会话' }
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 960, minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.loadURL(url)
  mainWindow.on('closed', () => { mainWindow = null })

  // F5 刷新
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') {
      event.preventDefault()
      mainWindow.webContents.reload()
    }
  })

  // 关窗口 → 最小化到托盘
  mainWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); mainWindow.hide(); log('window hidden to tray') }
  })

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost')) return { action: 'allow' }
    shell.openExternal(target)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) { event.preventDefault(); shell.openExternal(target) }
  })
}

function openSessionsWindow() {
  if (sessionsWin && !sessionsWin.isDestroyed()) { sessionsWin.focus(); return }
  sessionsWin = new BrowserWindow({
    width: 620, height: 680, title: '会话管理 — DeepSeek Harness Desktop',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'sessions-preload.js'),
    },
  })
  sessionsWin.setMenuBarVisibility(false)
  sessionsWin.loadFile(path.join(__dirname, 'sessions.html'))
  sessionsWin.on('closed', () => { sessionsWin = null })

  ipcMain.removeHandler('sessions:list')
  ipcMain.removeHandler('sessions:remove')
  ipcMain.handle('sessions:list', () => listSessions())
  ipcMain.handle('sessions:remove', (_e, id) => deleteSession(id))
}

/* ------------------------------------------------------------------ *
 * 选区截图
 * ------------------------------------------------------------------ */

function openShotWindow() {
  if (shotWindow && !shotWindow.isDestroyed()) { shotWindow.focus(); return }
  const display = screen.getPrimaryDisplay()
  const bounds = display.bounds
  shotWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'screenshot-preload.js'),
    },
  })
  shotWindow.setAlwaysOnTop(true, 'screen-saver')
  shotWindow.setBounds(bounds)
  shotWindow.loadFile(path.join(__dirname, 'screenshot.html'))
  shotWindow.webContents.once('did-finish-load', () => {
    if (pendingShot && !shotWindow.isDestroyed()) shotWindow.webContents.send('screenshot:data', pendingShot.toDataURL())
  })
  shotWindow.on('closed', () => { shotWindow = null })
}

function onShotLoaded() {
  if (shotWindow && !shotWindow.isDestroyed()) { shotWindow.show(); shotWindow.focus() }
}

function onShotDone(rect) {
  shotLog('shot: done called', rect ? JSON.stringify(rect) : 'null')
  const image = pendingShot
  pendingShot = null
  if (shotWindow && !shotWindow.isDestroyed()) shotWindow.destroy()
  showMainWindow()
  if (!image || !rect) { shotLog('shot: done skipped'); return }
  const sf = screen.getPrimaryDisplay().scaleFactor || 1
  const r = { x: Math.round(rect.x * sf), y: Math.round(rect.y * sf), width: Math.round(rect.w * sf), height: Math.round(rect.h * sf) }
  if (r.width <= 0 || r.height <= 0) { shotLog('shot: invalid crop rect'); return }
  const cropped = image.crop(r)
  shotLog('shot: cropped', cropped.getSize().width + 'x' + cropped.getSize().height)
  try {
    const dir = path.join(os.homedir(), '.dsh', 'screenshots')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    fs.writeFileSync(file, cropped.toPNG())
    shotLog('shot: saved', file)
  } catch (e) { shotLog('shot: save failed', String(e && e.message || e)) }
  clipboard.writeImage(cropped)
  shotLog('shot: written to clipboard')
  if (mainWindow && !mainWindow.isDestroyed()) {
    setTimeout(async () => {
      let focused = false
      try { focused = await mainWindow.webContents.executeJavaScript(`(() => { const el = document.querySelector('textarea, [contenteditable="true"]'); if (el) { el.focus(); return true } return false })()`) }
      catch { focused = false }
      if (focused) mainWindow.webContents.paste()
      else dialog.showMessageBox(mainWindow, { type: 'info', message: '截图已复制到剪贴板，请在聊天输入框按 Ctrl+V 粘贴', buttons: ['好'] })
    }, 400)
  }
}

function onShotCancel() {
  pendingShot = null
  if (shotWindow && !shotWindow.isDestroyed()) shotWindow.destroy()
  showMainWindow()
}

/* ------------------------------------------------------------------ *
 * 系统托盘
 * ------------------------------------------------------------------ */

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness (WSL)')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      {
        label: '打开截图目录',
        click: () => { const dir = path.join(os.homedir(), '.dsh', 'screenshots'); fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir) },
      },
      { type: 'separator' },
      {
        label: '退出', click: () => { isQuitting = true; app.quit() },
      },
    ])
  )
  tray.on('double-click', showMainWindow)
}

function showMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

/* ------------------------------------------------------------------ *
 * 应用菜单
 * ------------------------------------------------------------------ */

function createApplicationMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '会话管理…', click: () => openSessionsWindow() },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', click: () => { isQuitting = true; app.quit() } },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => { if (mainWindow) mainWindow.webContents.reload() } },
        { label: '强制重新加载（清缓存）', accelerator: 'CmdOrCtrl+Shift+R', click: () => { if (mainWindow) mainWindow.webContents.reloadIgnoringCache() } },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { label: '开发者工具', accelerator: 'F12', click: () => { if (mainWindow) mainWindow.webContents.toggleDevTools() } },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ *
 * 应用生命周期
 * ------------------------------------------------------------------ */

app.setAppUserModelId('com.dsh.desktop.wsl')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  })

  app.whenReady().then(async () => {
    const port = resolvePort()
    log(`connecting to dsh on 127.0.0.1:${port} (WSL)...`)

    // 探测 WSL 中的 DSH 服务是否已启动
    const serverUp = await probe(port)
    if (!serverUp) {
      const detail = `请确保 WSL 中已启动 dsh web 服务：

  在 WSL 终端中执行：
    dsh --profile web

或者如果已启动，检查端口 ${port} 是否被占用。
可换端口启动：dsh-desktop --port <新端口>`
      dialog.showErrorBox('无法连接到 WSL 中的 DSH', detail)
      app.quit()
      return
    }

    log('dsh is reachable, opening window...')
    createWindow(`http://127.0.0.1:${port}`)
    createTray()
    createApplicationMenu()
    checkForUpdates()

    // 悬浮刷新按钮
    ipcMain.on('dsh-desktop:reload', () => { if (mainWindow) mainWindow.webContents.reload() })

    // 选区截图
    ipcMain.handle('dsh-desktop:capture', async () => {
      shotLog('capture: requested')
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
        await new Promise((r) => setTimeout(r, 250))
        const display = screen.getPrimaryDisplay()
        const sf = display.scaleFactor || 1
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) },
        })
        if (!sources.length) { showMainWindow(); shotLog('capture: no screen source'); return { ok: false, error: '未找到屏幕源' } }
        pendingShot = sources[0].thumbnail
        if (pendingShot.isEmpty()) { showMainWindow(); shotLog('capture: empty thumbnail'); return { ok: false, error: '截图为空' } }
        shotLog('capture: captured', pendingShot.getSize().width + 'x' + pendingShot.getSize().height)
        openShotWindow()
        return { ok: true }
      } catch (e) { showMainWindow(); shotLog('capture: error', String((e && e.message) || e)); return { ok: false, error: String((e && e.message) || e) } }
    })

    ipcMain.on('dsh-desktop:toast', (_e, msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, { type: 'info', message: String(msg), buttons: ['好'] })
    })
    ipcMain.on('screenshot:done', (_e, rect) => onShotDone(rect))
    ipcMain.on('screenshot:cancel', () => onShotCancel())
    ipcMain.on('screenshot:loaded', () => onShotLoaded())
  })

  app.on('window-all-closed', () => {})
}