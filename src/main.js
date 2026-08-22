'use strict'

/**
 * dsh-desktop (WSL 适配版) — Electron 壳，连接 WSL 中已有的 DeepSeek Harness Web UI。
 *
 * 与原版区别：
 *   - 不尝试在本地启动/管理 dsh 服务（dsh 在 WSL 中运行）
 *   - 启动时检测 localhost:3080 是否可达，不可达则提示用户启动 WSL 中的 dsh
 *   - 移除环境检测、引导安装、dsh 进程管理等功能
 *   - 保留：独立窗口、系统托盘、选区截图、会话管理、更新检查
 *   - 新增：主动更新 WSL 内 DSH（检查 npm 新版 → 更新包 → 重启服务 → 自动重连）
 */

const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage, ipcMain, desktopCapturer, clipboard, screen } = require('electron')
const http = require('node:http')
const https = require('node:https')
const { spawn } = require('node:child_process')
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
  // 匹配 x.y.z 及可选预发布段（-rc.N / -beta.1 / -alpha 等），如 0.1.1-rc.2
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z]+)\.?(\d+)?)?(?:[-+.].*)?$/.exec(v.trim())
  if (!m) return null
  const preRank = m[4] ? { alpha: 0, beta: 1, rc: 2 }[m[4].toLowerCase()] ?? -1 : Infinity
  return [Number(m[1]), Number(m[2]), Number(m[3]), preRank, m[5] ? Number(m[5]) : 0]
}

function isNewer(a, b) {
  const pa = parseVersion(a); const pb = parseVersion(b)
  if (!pa || !pb) return false
  for (let i = 0; i < pa.length; i++) { if (pa[i] !== pb[i]) return pa[i] > pb[i] }
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
 * DSH 主动更新（WSL 内）
 *
 * 流程：启动时静默检查 → 发现新版弹窗询问 → npm 更新包 → systemctl
 * 重启 dsh 服务 → 轮询端口自动重连。也可从托盘 / 文件菜单手动触发。
 * 前提：WSL 以 systemd 启用且存在 dsh.service（无 systemd 时降级为提示手动重启）。
 * ------------------------------------------------------------------ */

const DSH_NPM_PACKAGE = '@deepseek-ai/dsh'
const DSH_CHECK_TIMEOUT_MS = 15_000
const DSH_INSTALL_TIMEOUT_MS = 300_000
const DSH_RESTART_TIMEOUT_MS = 60_000
const DSH_RECONNECT_TIMEOUT_MS = 90_000
const DSH_RECONNECT_INTERVAL_MS = 1_500

let updatingDsh = false

/**
 * 在 WSL 默认发行版中执行一条 bash 命令。
 * 返回 { code, stdout, stderr }；wsl.exe 不可用（未安装 WSL）时返回 null。
 * wsl.exe 自身报错输出为 UTF-16LE，而 Linux 命令输出为 UTF-8，按是否含 NUL 字节判别解码。
 */
function wslExec(command, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('wsl.exe', ['-e', 'bash', '-lc', command], { windowsHide: true })
    } catch (e) {
      log('wsl.exe spawn failed:', e && e.message)
      resolve(null)
      return
    }
    child.on('error', (e) => { log('wsl.exe not available:', e && e.message); resolve(null) })
    const out = []; const err = []
    let settled = false
    const done = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const decode = (bufs) => {
        const buf = Buffer.concat(bufs)
        if (buf.includes(0)) return buf.toString('utf16le') // wsl.exe 自身的报错
        return buf.toString('utf8')
      }
      resolve({ code, stdout: decode(out).trim(), stderr: decode(err).trim() })
    }
    const timer = setTimeout(() => { log(`wsl exec timeout (${timeoutMs}ms):`, command.slice(0, 60)); try { child.kill() } catch { /* ignore */ } done(-1) }, timeoutMs)
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('close', (code) => done(code))
  })
}

/** 读取 WSL 内已安装的 DSH 版本（如 "0.1.1-rc.2"）；读不到返回 null。 */
async function getWslDshVersion() {
  const r = await wslExec('dsh --version 2>/dev/null', DSH_CHECK_TIMEOUT_MS)
  if (!r) return null
  const m = /\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+)?/.exec(r.stdout)
  return m ? m[0] : null
}

/** 查询 npm 上 DSH 最新版本号；走 WSL 内 npm（与实际安装同源，兼容镜像源配置）。失败返回 null。 */
async function getNpmLatestVersion() {
  const r = await wslExec(`npm view ${DSH_NPM_PACKAGE} version 2>/dev/null`, DSH_CHECK_TIMEOUT_MS)
  if (!r || r.code !== 0) return null
  const m = /\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+)?/.exec(r.stdout)
  return m ? m[0] : null
}

/** 更新期间把主窗口切到轻量进度页，避免暴露连接错误页。 */
function showUpdateSplash(stepText) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const page = `<!doctype html><html><meta charset="utf-8"><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0d1117;color:#e6edf3;font-family:system-ui,'Microsoft YaHei';user-select:none">
  <div style="text-align:center"><div style="font-size:44px;margin-bottom:18px">⬆️</div>
  <div style="font-size:20px;margin-bottom:10px">正在更新 DSH</div>
  <div id="s" style="font-size:13px;color:#8b949e">${stepText}</div>
  <div style="margin-top:22px;font-size:12px;color:#484f58">完成后将自动重连，请勿关闭应用</div></div></body></html>`
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page)).catch(() => {})
}

/** 任务栏进度指示：0-1 确定进度，2 = 不确定态，-1 = 清除。 */
function setUpdateProgress(value) {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(value) } catch { /* ignore */ }
}

/**
 * 执行更新：npm 安装新版 → 校验版本 → 重启 dsh 服务 → 等端口恢复 → 重载页面。
 * 抛错时由调用方负责展示（错误里附带手动修复命令）。
 */
async function performDshUpdate(port, targetVersion) {
  const steps = [
    `npm 安装 ${DSH_NPM_PACKAGE}@latest（最长 5 分钟）`,
    '校验新版本',
    '重启 dsh 服务（systemctl restart dsh）',
    '等待服务就绪并重连',
  ]
  log(`dsh update: begin, target=${targetVersion || 'latest'}`)
  showUpdateSplash(steps[0])
  setUpdateProgress(2)

  // 1) npm 全局更新（--no-fund/--no-audit 减少网络依赖与耗时）
  const install = await wslExec(
    `npm install -g ${DSH_NPM_PACKAGE}@latest --no-fund --no-audit 2>&1`,
    DSH_INSTALL_TIMEOUT_MS
  )
  if (!install) throw new Error('无法调用 wsl.exe，请确认 Windows 已安装 WSL')
  if (install.code !== 0) {
    throw new Error(`npm 安装失败（exit ${install.code}）：\n${(install.stderr || install.stdout || '').split('\n').slice(-6).join('\n')}`)
  }

  // 2) 校验版本确实换新（npm 偶发装了旧版缓存时能及时发现）
  showUpdateSplash(steps[1])
  const installed = await getWslDshVersion()
  log(`dsh update: installed=${installed || '?'}`)
  if (installed && targetVersion && !isNewer(installed, targetVersion) && installed !== targetVersion) {
    log('dsh update: version mismatch after install, continuing anyway')
  }

  // 3) 重启 systemd 服务；无 systemd 时降级为提示
  showUpdateSplash(steps[2])
  const restart = await wslExec('systemctl restart dsh 2>&1', DSH_RESTART_TIMEOUT_MS)
  let restartManual = false
  if (!restart || restart.code !== 0) {
    const msg = restart ? (restart.stderr || restart.stdout || '') : ''
    if (/systemd|System has not been booted/i.test(msg)) {
      restartManual = true
      log('dsh update: systemd unavailable, asking user to restart manually')
    } else {
      throw new Error(`重启服务失败：\n${msg || 'systemctl restart dsh 返回非零'}`)
    }
  }

  // 4) 轮询端口直到服务恢复，然后重载页面
  showUpdateSplash(steps[3])
  const deadline = Date.now() + DSH_RECONNECT_TIMEOUT_MS
  let back = false
  while (Date.now() < deadline) {
    if (await probe(port, 1200)) { back = true; break }
    await new Promise((r) => setTimeout(r, DSH_RECONNECT_INTERVAL_MS))
  }
  setUpdateProgress(-1)
  if (back) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
  } else {
    log('dsh update: service did not come back within timeout')
  }

  const finalVersion = installed || targetVersion || '最新版'
  if (restartManual) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning', title: '更新完成，需手动重启',
      message: `DSH 已更新到 ${finalVersion}，但未检测到 systemd，无法自动重启服务。`,
      detail: '请在 WSL 终端手动执行：\n  systemctl restart dsh\n或重启你的 dsh 启动命令，然后按 F5 刷新本窗口。',
      buttons: ['好'], noLink: true,
    })
  } else if (back) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'info', title: '更新完成',
      message: `DSH 已更新到 ${finalVersion}，服务已重启并重新连接。`,
      buttons: ['好'], noLink: true,
    })
  } else {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning', title: '更新完成，等待服务就绪',
      message: `DSH 已更新到 ${finalVersion}，但服务在 ${Math.round(DSH_RECONNECT_TIMEOUT_MS / 1000)}s 内未恢复。`,
      detail: `可能仍在启动中。稍后按 F5 刷新即可；也可在 WSL 中执行 systemctl status dsh 查看状态。`,
      buttons: ['好'], noLink: true,
    })
  }
  log(`dsh update: done, version=${finalVersion} reconnected=${back}`)
}

/**
 * 检查并（经确认后）更新 DSH。
 * @param silent 无新版/无法检测时不弹窗（用于启动时自动检查）
 */
async function checkDshUpdate(silent = false) {
  if (updatingDsh) { if (!silent) dialog.showMessageBox(mainWindow || undefined, { type: 'info', message: 'DSH 正在更新中，请稍候。', buttons: ['好'], noLink: true }); return }
  const port = resolvePort()
  const [current, latest] = await Promise.all([getWslDshVersion(), getNpmLatestVersion()])
  log(`dsh update check: current=${current || '?'} latest=${latest || '?'}`)

  if (!current || !latest) {
    if (!silent) {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'warning', title: '无法检查 DSH 更新',
        message: !current ? '未能读取 WSL 中的 DSH 版本。' : '未能获取 npm 上的最新版本（检查网络）。',
        detail: !current ? '请确认 WSL 可用且已安装 dsh（wsl -e dsh --version）。' : `手动查询：https://www.npmjs.com/package/${DSH_NPM_PACKAGE}`,
        buttons: ['好'], noLink: true,
      })
    }
    return
  }
  if (!isNewer(latest, current)) {
    if (!silent) dialog.showMessageBox(mainWindow || undefined, { type: 'info', title: '已是最新', message: `WSL 中的 DSH（${current}）已是最新版本。`, buttons: ['好'], noLink: true })
    return
  }

  const { response } = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'question', title: '发现 DSH 新版本',
    message: `WSL 中的 DSH 可以更新：${current} → ${latest}`,
    detail: `更新过程约 1-3 分钟：下载安装新包 → 自动重启 dsh 服务 → 自动重连窗口。\n期间 Web 页面会短暂不可用，请勿关闭应用。\n\n手动执行等价于：\n  npm install -g ${DSH_NPM_PACKAGE}@latest\n  systemctl restart dsh`,
    buttons: ['立即更新', '暂不'], defaultId: 0, cancelId: 1, noLink: true,
  })
  if (response === 0) {
    try {
      await performDshUpdate(port, latest)
    } catch (e) {
      setUpdateProgress(-1)
      log('dsh update failed:', e && e.message)
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'error', title: 'DSH 更新失败',
        message: '更新过程中出现问题，可稍后重试',
        detail: `${String(e && e.message || e)}\n\n也可在 WSL 中手动执行：\n  npm install -g ${DSH_NPM_PACKAGE}@latest\n  systemctl restart dsh`,
        buttons: ['好'], noLink: true,
      })
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
    }
  }
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
      { label: '检查 DSH 更新', click: () => checkDshUpdate(false) },
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
        { label: '检查 DSH 更新…', click: () => checkDshUpdate(false) },
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

    // 启动 3s 后静默检查 WSL 内 DSH 是否有新版本，有则弹窗询问
    setTimeout(() => checkDshUpdate(true).catch((e) => log('dsh update check error:', e && e.message)), 3_000)

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