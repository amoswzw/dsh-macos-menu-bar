/* Installed through the loopback Node inspector before Desktop shows its first page. */
(() => {
  const settings = __DSH_MENU_BAR_CONFIG__
  if (globalThis.__dshMacosMenuBarV1) return 'already-installed'
  const requireMain = process.getBuiltinModule('module').createRequire(process.execPath)
  const { app, BrowserWindow, dialog, Menu, nativeImage, screen, systemPreferences, Tray } = requireMain('electron')
  const net = requireMain('node:net')
  const fs = requireMain('node:fs')
  const path = requireMain('node:path')
  const inspector = requireMain('node:inspector')
  let nativePanel
  if (typeof settings.addonPath === 'string') {
    try { nativePanel = requireMain(settings.addonPath) }
    catch (error) { console.error('dsh-macos-menu-bar: native notch panel could not load', error) }
  }
  const nativeAvailable = () => {
    try { return nativePanel?.metrics().available === 1 }
    catch { return false }
  }
  let tray
  let popupWindow
  let originalBounds
  let originalVisibleOnAllWorkspaces
  let popupBlurHandler
  let popupAnimation
  let popupAnchor
  let popupMouseTimer
  let popupMouseGraceUntil = 0
  let suppressNotchHoverUntilExit = false
  let disposed = false
  let suppressStartupWindow = true
  let options = { maxWidth: 1120, maxHeight: 850, hideOnBlur: true, hideOnMouseLeave: true,
    notchHover: false, notchApprovals: false, compactApprovals: false, hideTrayIcon: false, language: 'auto' }
  const language = () => options.language === 'auto'
    ? (app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en') : options.language
  const words = () => language() === 'zh-CN'
    ? { session: '会话', reject: '拒绝', review: '详情', allow: '允许一次', approve: '允许工具执行吗？',
      preview: '审批弹窗预览', previewCommand: 'git status --short',
      previewDetail: '这是示例审批卡片。选择任何按钮都不会授权任务。',
      open: '打开 DeepSeek Harness', quit: '退出 DeepSeek Harness' }
    : { session: 'Session', reject: 'Reject', review: 'Details', allow: 'Allow once', approve: 'Approve tool access?',
      preview: 'Approval preview', previewCommand: 'git status --short',
      previewDetail: 'This is a sample approval card. No choice will authorize a task.',
      open: 'Open DeepSeek Harness', quit: 'Quit DeepSeek Harness' }
  let hoverTimer
  let nativeEventTimer
  let nextNativeApprovalId = 0
  const nativeApprovalResolvers = new Map()
  let approvalPanel
  let activeApproval
  const approvalQueue = []
  let approvalPresentationCount = 0
  let runningCount = 0
  const displayChanged = () => { configureTray(); configureHover() }
  const originalShow = BrowserWindow.prototype.show
  const originalShowInactive = BrowserWindow.prototype.showInactive
  const suppress = window => suppressStartupWindow && popupWindow !== window
    && window.webContents.getURL().startsWith('dsh-app://app/')
  BrowserWindow.prototype.show = function (...args) {
    if (!suppress(this)) return originalShow.apply(this, args)
  }
  BrowserWindow.prototype.showInactive = function (...args) {
    if (!suppress(this)) return originalShowInactive.apply(this, args)
  }

  function primaryWindow() {
    return BrowserWindow.getAllWindows().find(window => !window.isDestroyed()
      && window.webContents.getURL().startsWith('dsh-app://app/'))
  }

  function restoreWindow() {
    const window = popupWindow
    popupWindow = undefined
    finishPopupAnimation()
    if (popupMouseTimer) clearInterval(popupMouseTimer)
    popupMouseTimer = undefined
    popupAnchor = undefined
    popupMouseGraceUntil = 0
    if (window && !window.isDestroyed()) {
      if (popupBlurHandler) window.removeListener('blur', popupBlurHandler)
      window.setAlwaysOnTop(false)
      if (originalVisibleOnAllWorkspaces !== undefined) {
        window.setVisibleOnAllWorkspaces?.(originalVisibleOnAllWorkspaces,
          { visibleOnFullScreen: true, skipTransformProcessType: true })
      }
      if (originalBounds) window.setBounds(originalBounds)
    }
    originalBounds = undefined
    originalVisibleOnAllWorkspaces = undefined
    popupBlurHandler = undefined
  }

  function contains(bounds, point) {
    return bounds && point.x >= bounds.x && point.x < bounds.x + bounds.width
      && point.y >= bounds.y && point.y < bounds.y + bounds.height
  }

  function configurePopupMouseTracking() {
    if (popupMouseTimer) clearInterval(popupMouseTimer)
    popupMouseTimer = undefined
    const window = popupWindow
    if (!options.hideOnMouseLeave || !window || window.isDestroyed() || !window.isVisible()) return
    let outsideTicks = 0
    popupMouseTimer = setInterval(() => {
      if (popupWindow !== window || window.isDestroyed() || !window.isVisible()) return
      if (Date.now() < popupMouseGraceUntil) return
      const point = screen.getCursorScreenPoint()
      const anchor = popupAnchor === 'notch' ? notchHitRegion() : tray?.getBounds()
      if (contains(window.getBounds(), point) || contains(anchor, point)) { outsideTicks = 0; return }
      if (++outsideTicks >= 2) { window.hide(); restoreWindow() }
    }, 80)
    popupMouseTimer.unref()
  }

  function finishPopupAnimation() {
    const animation = popupAnimation
    popupAnimation = undefined
    if (!animation) return
    clearInterval(animation.timer)
    if (animation.window.isDestroyed()) return
    animation.window.setPosition(animation.x, animation.y)
    animation.window.setOpacity(animation.opacity)
  }

  function animatePopup(window, bounds, work) {
    const settings = systemPreferences?.getAnimationSettings?.()
    if (settings?.prefersReducedMotion || typeof window.setOpacity !== 'function'
      || typeof window.setPosition !== 'function') return false
    const maxY = work.y + work.height - bounds.height
    const startY = Math.min(bounds.y + 12, maxY)
    if (startY <= bounds.y) return false
    const opacity = window.getOpacity?.() ?? 1
    window.setBounds({ ...bounds, y: startY })
    window.setOpacity(0)
    const started = Date.now()
    const timer = setInterval(() => {
      if (window.isDestroyed() || popupWindow !== window || !window.isVisible()) {
        finishPopupAnimation()
        return
      }
      const progress = Math.min(1, (Date.now() - started) / 180)
      const eased = 1 - (1 - progress) ** 3
      window.setPosition(bounds.x, Math.round(startY + (bounds.y - startY) * eased))
      window.setOpacity(opacity * eased)
      if (progress === 1) finishPopupAnimation()
    }, 16)
    timer.unref()
    popupAnimation = { window, timer, x: bounds.x, y: bounds.y, opacity }
    return true
  }

  function openFullWindow() {
    suppressStartupWindow = false
    restoreWindow()
    const window = primaryWindow()
    if (!window) { app.focus({ steal: true }); return }
    if (window.isMinimized()) window.restore()
    window.show()
    app.focus({ steal: true })
    window.focus()
  }

  function prepareApprovalPresentation() {
    suppressNotchHoverUntilExit = true
    const window = popupWindow
    if (!window || window.isDestroyed()) return
    if (window.isVisible()) window.hide()
    restoreWindow()
  }

  function activatePopup(window) {
    let attempts = 0
    const check = () => {
      if (popupWindow !== window || window.isDestroyed() || !window.isVisible()) return
      if (!app.isActive() || !window.isFocused()) {
        app.focus({ steal: true })
        window.focus()
      }
      if (++attempts < 12) setTimeout(check, 200).unref()
    }
    check()
  }

  function toggleWindow(anchor = 'tray', forReview = false) {
    if (!forReview && !activeApproval?.reviewing
      && (approvalPresentationCount || activeApproval || approvalQueue.length)) return
    suppressStartupWindow = true
    const window = primaryWindow()
    if (!window) { app.focus({ steal: true }); return }
    if (popupWindow === window && window.isVisible()) {
      if (forReview) { activatePopup(window); return }
      window.hide()
      restoreWindow()
      return
    }
    if (window.isFullScreen()) window.setFullScreen(false)
    if (popupWindow !== window) {
      originalBounds = window.getBounds()
      originalVisibleOnAllWorkspaces = window.isVisibleOnAllWorkspaces?.() ?? false
      popupWindow = window
    }
    popupAnchor = anchor
    const icon = anchor === 'notch' ? notchAnchor() : tray.getBounds()
    const work = screen.getDisplayNearestPoint({ x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 }).workArea
    const sideMargin = Math.min(12, Math.floor(work.width / 40))
    const bottomMargin = Math.min(12, Math.floor(work.height / 30))
    const width = Math.max(1, Math.min(options.maxWidth, work.width - sideMargin * 2))
    const height = Math.max(1, Math.min(options.maxHeight, work.height - bottomMargin))
    const x = Math.max(work.x, Math.min(icon.x + icon.width / 2 - width / 2, work.x + work.width - width))
    const below = icon.y + icon.height
    const y = below + height <= work.y + work.height ? below : work.y + work.height - height
    const bounds = { x: Math.round(x), y: Math.round(y), width, height }
    finishPopupAnimation()
    const animated = animatePopup(window, bounds, work)
    if (!animated) window.setBounds(bounds)
    window.setVisibleOnAllWorkspaces?.(true,
      { visibleOnFullScreen: true, skipTransformProcessType: true })
    window.setAlwaysOnTop(true, 'pop-up-menu')
    if (window.isMinimized()) window.restore()
    window.show()
    configurePopupMouseTracking()
    activatePopup(window)
    popupBlurHandler = () => {
      if (options.hideOnBlur && popupWindow === window && !window.isDestroyed() && window.isVisible()) {
        window.hide()
        restoreWindow()
      }
    }
    window.once('blur', popupBlurHandler)
  }

  function openReviewWindow() {
    toggleWindow(options.notchHover && internalDisplay() ? 'notch' : 'tray', true)
    popupMouseGraceUntil = Date.now() + 1200
  }

  function notchAnchor() {
    const display = internalDisplay() || screen.getPrimaryDisplay()
    const top = display.bounds.y
    const menuHeight = Math.max(24, display.workArea.y - top)
    return { x: display.bounds.x + display.bounds.width / 2 - 1, y: top, width: 2, height: menuHeight }
  }

  function notchHitRegion() {
    const display = internalDisplay()
    if (!display) return undefined
    const metrics = nativeAvailable() ? nativePanel.metrics() : undefined
    const menuHeight = Math.max(24, display.workArea.y - display.bounds.y)
    const width = metrics?.width || 240
    return { x: display.bounds.x + (display.bounds.width - width) / 2,
      y: display.bounds.y, width, height: Math.max(menuHeight, metrics?.height || 0) }
  }

  function internalDisplay() {
    return screen.getAllDisplays?.().find(display => display.internal)
      || (screen.getPrimaryDisplay().internal ? screen.getPrimaryDisplay() : undefined)
  }

  function configureHover() {
    if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = undefined }
    nativePanel?.hideIsland()
    if (!options.notchHover || !internalDisplay()) return
    if (nativeAvailable()) {
      nativePanel.showIsland(settings.iconPath
        || path.resolve(path.dirname(process.execPath), '../Resources/icon.png'))
      updateIndicator()
    }
    hoverTimer = setInterval(() => {
      if (disposed || !activeApproval?.reviewing
        && (approvalPresentationCount || activeApproval || approvalQueue.length)) return
      const point = screen.getCursorScreenPoint()
      if (!contains(notchHitRegion(), point)) { suppressNotchHoverUntilExit = false; return }
      if ((activeApproval?.reviewing || !suppressNotchHoverUntilExit)
        && !primaryWindow()?.isVisible()) toggleWindow('notch')
    }, 120)
    hoverTimer.unref()
  }

  function updateIndicator() {
    if (nativeAvailable()) nativePanel.setIndicator(activeApproval || approvalQueue.length ? 2 : runningCount ? 1 : 0)
  }

  function islandApproval(title, message, buttons, preview = false) {
    if (nativeAvailable()) return new Promise(resolve => {
      const id = ++nextNativeApprovalId
      nativeApprovalResolvers.set(id, resolve)
      try { nativePanel.showApproval(title, message, buttons, preview, id, options.compactApprovals) }
      catch (error) { nativeApprovalResolvers.delete(id); console.error('dsh-macos-menu-bar: native approval failed', error); resolve(0) }
    })
    return new Promise(resolve => {
      if (approvalPanel && !approvalPanel.isDestroyed()) approvalPanel.close()
      const display = screen.getPrimaryDisplay()
      const work = display.workArea
      const width = Math.min(440, work.width - 24)
      const height = Math.min(196, work.height - 24)
      const panel = new BrowserWindow({
        x: Math.round(work.x + (work.width - width) / 2), y: work.y + 4,
        width, height, frame: false, transparent: true, resizable: false, minimizable: false,
        maximizable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      panel.setAlwaysOnTop(true, 'pop-up-menu')
      panel.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
      approvalPanel = panel
      let done = false
      const finish = index => {
        if (done) return
        done = true
        if (approvalPanel === panel) approvalPanel = undefined
        if (!panel.isDestroyed()) panel.close()
        resolve(index)
      }
      panel.on('closed', () => finish(0))
      panel.webContents.on('will-navigate', (event, url) => {
        event.preventDefault()
        const match = /^dsh-menu-choice:\/\/select\/(\d+)$/u.exec(url)
        if (match) finish(Number(match[1]))
      })
      const escape = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
      const body = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;color:white;font:14px -apple-system,BlinkMacSystemFont,sans-serif}main{box-sizing:border-box;height:100vh;padding:17px 20px;background:rgba(20,20,24,.96);border:1px solid rgba(255,255,255,.17);border-radius:24px;box-shadow:0 12px 28px #0006;display:flex;flex-direction:column}h1{font-size:15px;margin:0 0 8px}p{margin:0;line-height:1.35;overflow:auto;flex:1;color:#ddd}footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}button{border:0;border-radius:10px;padding:8px 13px;background:#393940;color:white;font:inherit;cursor:pointer}button:last-child{background:#1877e8}</style><main><h1>${escape(title)}</h1><p>${escape(message)}</p><footer>${buttons.map((button, index) => `<button onclick="location.href='dsh-menu-choice://select/${index}'">${escape(button)}</button>`).join('')}</footer></main>`
      panel.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(body)).then(() => {
        if (done) return
        panel.show()
        app.focus({ steal: true })
        panel.focus()
      }).catch(() => finish(0))
    })
  }

  function startNativeEvents() {
    if (!nativeAvailable() || nativeEventTimer) return
    nativeEventTimer = setInterval(() => {
      if (disposed) return
      try {
        for (let index = 0; index < 32; index++) {
          const event = nativePanel.pollEvents()
          if (Number.isSafeInteger(event.approvalId)) {
            const resolve = nativeApprovalResolvers.get(event.approvalId)
            nativeApprovalResolvers.delete(event.approvalId)
            resolve?.(event.choice)
          }
          if (!Number.isSafeInteger(event.approvalId)) break
        }
      } catch (error) { console.error('dsh-macos-menu-bar: native event polling failed', error) }
    }, 80)
    nativeEventTimer.unref()
  }

  function showNextApproval() {
    if (disposed || activeApproval || approvalQueue.length === 0) return
    const item = approvalQueue.shift()
    activeApproval = item
    updateIndicator()
    prepareApprovalPresentation()
    void islandApproval(item.title, item.message, item.buttons).then(response => {
      item.resolve(response)
      if (item.holdForReview && response === 1) {
        item.reviewing = true
        return
      }
      if (activeApproval === item) activeApproval = undefined
      updateIndicator()
      showNextApproval()
    }, () => {
      item.resolve(0)
      if (activeApproval === item) activeApproval = undefined
      updateIndicator()
      showNextApproval()
    })
    if (nativeAvailable()) nativePanel.updateApprovalQueue(approvalQueue.length, language())
  }

  function queueApproval(socket, id, title, message, buttons, holdForReview = false) {
    return new Promise(resolve => {
      approvalQueue.push({ socket, id, title, message, buttons, holdForReview, resolve })
      updateIndicator()
      showNextApproval()
      if (nativeAvailable()) nativePanel.updateApprovalQueue(approvalQueue.length, language())
    })
  }

  function cancelApproval(socket, targetId) {
    const pending = approvalQueue.findIndex(item => item.socket === socket && item.id === targetId)
    if (pending !== -1) approvalQueue.splice(pending, 1)[0].resolve(0)
    updateIndicator()
    if (nativeAvailable()) nativePanel.updateApprovalQueue(approvalQueue.length, language())
    if (activeApproval?.socket === socket && activeApproval.id === targetId) {
      if (activeApproval.reviewing) {
        activeApproval = undefined
        updateIndicator()
        showNextApproval()
      } else if (nativeAvailable()) nativePanel.hideApproval()
      else if (approvalPanel && !approvalPanel.isDestroyed()) approvalPanel.close()
    }
  }

  function finishReview(socket, targetId) {
    if (!activeApproval?.reviewing || activeApproval.socket !== socket || activeApproval.id !== targetId) return
    activeApproval = undefined
    updateIndicator()
    showNextApproval()
  }

  function createTray() {
    if (disposed) return
    if (tray) return
    const icon = nativeImage.createFromPath(settings.iconPath
      || path.resolve(path.dirname(process.execPath), '../Resources/icon.png'))
    if (icon.isEmpty()) throw new Error('DeepSeek Harness menu bar icon is unavailable')
    tray = new Tray(icon.resize({ width: 18, height: 18 }))
    tray.setToolTip('DeepSeek Harness')
    tray.on('click', () => toggleWindow('tray'))
    tray.on('right-click', () => {
      tray.popUpContextMenu(Menu.buildFromTemplate([
        { label: words().open, click: openFullWindow },
        { type: 'separator' },
        { label: words().quit, click: () => app.quit() },
      ]))
    })
  }

  function configureTray() {
    if (options.hideTrayIcon && options.notchHover && screen.getPrimaryDisplay().internal && nativeAvailable()) {
      tray?.destroy()
      tray = undefined
    } else createTray()
  }

  function hideStartupWindow() {
    if (!suppressStartupWindow) return
    const window = primaryWindow()
    if (window && window.isVisible()) window.hide()
  }

  async function handle(request, socket) {
    if (request.method === 'ping') return { ready: !disposed && (tray !== undefined || options.hideTrayIcon && options.notchHover && nativeAvailable()) }
    if (request.method === 'activity') {
      if (!Number.isSafeInteger(request.runningCount) || request.runningCount < 0 || request.runningCount > 1000) return { outcome: 'unavailable' }
      runningCount = request.runningCount
      updateIndicator()
      return { updated: true }
    }
    if (request.method === 'cancel-approval') {
      if (Number.isSafeInteger(request.targetId)) cancelApproval(socket, request.targetId)
      return { cancelled: true }
    }
    if (request.method === 'finish-review') {
      if (Number.isSafeInteger(request.targetId)) finishReview(socket, request.targetId)
      return { finished: true }
    }
    if (request.method === 'preview-approval') {
      if (approvalPresentationCount || activeApproval || approvalQueue.length) return { preview: false }
      prepareApprovalPresentation()
      approvalPresentationCount++
      const w = words()
      void islandApproval(options.compactApprovals ? 'bash' : w.preview,
        `${w.previewCommand}\n${w.previewDetail}`, [w.reject, w.review, w.allow], true)
        .catch(error => console.error('dsh-macos-menu-bar: approval preview failed', error))
        .finally(() => { approvalPresentationCount-- })
      return { preview: true }
    }
    if (request.method === 'configure') {
      const next = request.settings
      if (!next || !Number.isInteger(next.maxWidth) || next.maxWidth < 680 || next.maxWidth > 1800
        || !Number.isInteger(next.maxHeight) || next.maxHeight < 600 || next.maxHeight > 1200
        || ['hideOnBlur', 'hideOnMouseLeave', 'notchHover', 'notchApprovals', 'compactApprovals', 'hideTrayIcon'].some(key => typeof next[key] !== 'boolean')
        || next.hideTrayIcon && !next.notchHover
        || next.compactApprovals && !next.notchApprovals
        || !['auto', 'en', 'zh-CN'].includes(next.language)) return { outcome: 'unavailable' }
      options = { maxWidth: next.maxWidth, maxHeight: next.maxHeight, hideOnBlur: next.hideOnBlur,
        hideOnMouseLeave: next.hideOnMouseLeave,
        notchHover: next.notchHover, notchApprovals: next.notchApprovals,
        compactApprovals: next.compactApprovals, hideTrayIcon: next.hideTrayIcon, language: next.language }
      if (app.isReady()) { configureTray(); configureHover(); configurePopupMouseTracking() }
      return { configured: true }
    }
    if (request.method === 'dispose') { dispose(); return { disposed: true } }
    if (request.method === 'question-approval') {
      if (typeof request.question !== 'string' || request.question.length > 4000
        || request.detail !== undefined && (typeof request.detail !== 'string' || request.detail.length > 4000)
        || !Array.isArray(request.labels) || request.labels.length < 2 || request.labels.length > 3
        || request.labels.some(label => typeof label !== 'string' || label.length === 0 || label.length > 200)) {
        return { outcome: 'unavailable' }
      }
      const activeLanguage = language() === 'zh-CN' ? 'zh' : 'en'
      approvalPresentationCount++
      const display = request.display
      const session = typeof request.sessionId === 'string' && request.sessionId.length <= 200
        ? `\n${words().session} ${request.sessionId.slice(-8)}` : ''
      const localize = value => typeof value === 'object' && value !== null
        ? typeof value[activeLanguage] === 'string' ? value[activeLanguage] : value.en
        : undefined
      try {
        const buttons = [request.labels[0], localize(display?.approve) || request.labels[1],
          ...request.labels.length === 3 ? [request.labels[2]] : []]
        const useNotch = options.notchApprovals && internalDisplay()
        if (!useNotch) prepareApprovalPresentation()
        const result = useNotch
          ? { response: await queueApproval(socket, request.id, localize(display?.question) || request.question,
            (localize(display?.detail) || request.detail || '') + session, buttons) }
          : await dialog.showMessageBox({ type: 'question',
          title: localize(display?.question) || request.question,
          detail: localize(display?.detail) || request.detail || '',
          buttons,
          defaultId: 0, cancelId: 0,
        })
        return { selected: request.labels[result.response] || request.labels[0] }
      } catch { return { outcome: 'unavailable' } }
      finally { approvalPresentationCount-- }
    }
    if (request.method !== 'approve') return { outcome: 'unavailable' }
    const displayReason = request.displayReason
    const validDisplayReason = displayReason === undefined || (displayReason !== null
      && typeof displayReason === 'object' && !Array.isArray(displayReason)
      && ['en', 'zh'].every(key => displayReason[key] === undefined
        || typeof displayReason[key] === 'string' && displayReason[key].length <= 4000))
    if (typeof request.toolName !== 'string' || request.toolName.length === 0 || request.toolName.length > 200
      || (request.reason !== undefined && (typeof request.reason !== 'string' || request.reason.length > 4000))
      || (request.command !== undefined && (typeof request.command !== 'string' || request.command.length > 4000))
      || !validDisplayReason) {
      return { outcome: 'unavailable' }
    }
    const w = words()
    const reason = displayReason?.[language() === 'zh-CN' ? 'zh' : 'en'] || request.reason || ''
    const session = typeof request.sessionId === 'string' && request.sessionId.length <= 200
      ? `${w.session} ${request.sessionId.slice(-8)}` : ''
    const details = [request.toolName, request.command, reason, session].filter(Boolean).join('\n')
    const compactSummary = [request.command || reason || request.toolName,
      ...(request.command && reason ? [reason] : []), session].filter(Boolean).join('\n')
    approvalPresentationCount++
    try {
      const buttons = [w.reject, w.review, w.allow]
      const useNotch = options.notchApprovals && internalDisplay()
      if (!useNotch) prepareApprovalPresentation()
      const result = useNotch
        ? { response: await queueApproval(socket, request.id, options.compactApprovals ? request.toolName : w.approve,
          options.compactApprovals ? compactSummary : details, buttons, true) }
        : await dialog.showMessageBox({ type: 'question',
        title: w.approve,
        message: request.toolName, detail: [request.command, reason].filter(Boolean).join('\n'),
        buttons,
        defaultId: 0, cancelId: 0,
      })
      if (result.response === 1) { openReviewWindow(); return { outcome: 'review' } }
      return { outcome: result.response === 2 ? 'allowed-once' : 'rejected' }
    } catch { return { outcome: 'unavailable' } }
    finally { approvalPresentationCount-- }
  }

  const server = net.createServer(socket => {
    socket.setEncoding('utf8')
    socket.on('close', () => {
      for (const item of [...approvalQueue]) cancelApproval(socket, item.id)
      if (activeApproval?.socket === socket) cancelApproval(socket, activeApproval.id)
    })
    let input = ''
    socket.on('data', chunk => {
      input += chunk
      if (input.length > 65_536) { socket.destroy(); return }
      let newline
      while ((newline = input.indexOf('\n')) !== -1) {
        const line = input.slice(0, newline)
        input = input.slice(newline + 1)
        let request
        try { request = JSON.parse(line) } catch { socket.destroy(); return }
        if (!request || request.token !== settings.token || !Number.isSafeInteger(request.id)) { socket.destroy(); return }
        void Promise.resolve(handle(request, socket)).then(result => {
          if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, ...result }) + '\n')
        }, () => {
          if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, outcome: 'unavailable' }) + '\n')
        })
      }
    })
  })
  server.on('error', error => {
    console.error('dsh-macos-menu-bar: native IPC failed', error)
    dispose()
  })
  server.listen(settings.socketPath, () => fs.chmodSync(settings.socketPath, 0o600))

  function dispose() {
    if (disposed) return
    disposed = true
    BrowserWindow.prototype.show = originalShow
    BrowserWindow.prototype.showInactive = originalShowInactive
    restoreWindow()
    tray?.destroy()
    for (const item of approvalQueue.splice(0)) item.resolve(0)
    if (hoverTimer) clearInterval(hoverTimer)
    if (nativeEventTimer) clearInterval(nativeEventTimer)
    for (const resolve of nativeApprovalResolvers.values()) resolve(0)
    nativeApprovalResolvers.clear()
    if (approvalPanel && !approvalPanel.isDestroyed()) approvalPanel.close()
    nativePanel?.hideApproval()
    nativePanel?.hideIsland()
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.off?.(event, displayChanged)
    if (server.listening) server.close()
    try { fs.unlinkSync(settings.socketPath) } catch { /* The socket may already be gone. */ }
    try { fs.rmdirSync(path.dirname(settings.socketPath)) } catch { /* An active client may still own the directory. */ }
    app.setActivationPolicy('regular')
    delete globalThis.__dshMacosMenuBarV1
  }

  globalThis.__dshMacosMenuBarV1 = {
    dispose,
    status: () => ({ trayBounds: tray?.getBounds(), nativePanel: nativePanel?.metrics(), appActive: app.isActive(),
      windowVisible: primaryWindow()?.isVisible(), windowFocused: primaryWindow()?.isFocused(),
      windowOnAllWorkspaces: primaryWindow()?.isVisibleOnAllWorkspaces?.(),
      windowOpacity: primaryWindow()?.getOpacity?.() }),
  }
  app.setActivationPolicy('accessory')
  void app.whenReady().then(() => {
    configureTray()
    configureHover()
    startNativeEvents()
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on?.(event, displayChanged)
    }
    hideStartupWindow()
    for (const delay of [100, 500, 1500]) setTimeout(hideStartupWindow, delay).unref()
  }).catch(error => {
    console.error('dsh-macos-menu-bar: tray failed to start', error)
    dispose()
  })
  app.once('will-quit', dispose)
  setTimeout(() => inspector.close(), 1000).unref()
  return 'installed'
})()
