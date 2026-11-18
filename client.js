window.__ModuleLoader__.load({
  id: '@amoswzw/dsh-macos-menu-bar',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    function Icon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 2, y: 3, width: 16, height: 14, rx: 4, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M7 3v3h6V3M5 11h10', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }
    function SettingsPage() {
      return h('div', { style: { position: 'relative', height: '100%', minHeight: 0 } },
        h('iframe', { title: '菜单栏与灵动岛设置', src: '/macos-menu-bar/settings.html',
          style: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block' } }))
    }
    return { inject: [], apply(ctx) {
      ctx.effect(() => {
        let stopped = false
        let timer
        let dispose = []
        let attempts = 0
        const install = () => {
          if (stopped) return
          let slots
          try { slots = ctx.get('slots') } catch { slots = ctx.slots }
          if (!slots) {
            if (++attempts < 300) timer = setTimeout(install, 50)
            return
          }
          try {
            dispose = [
              slots.inject('sidebar.panellist', () => slots.register({
                name: 'sidebar.panellist', id: 'macos-menu-bar', order: 45, label: () => '菜单栏与灵动岛',
              }, Icon)),
              slots.inject('main', () => slots.register({ name: 'main', key: 'macos-menu-bar' }, SettingsPage)),
            ]
          } catch (error) { console.warn('macos-menu-bar: settings page registration failed', error) }
        }
        install()
        return () => { stopped = true; clearTimeout(timer); for (const stop of dispose) if (typeof stop === 'function') stop() }
      }, 'macos-menu-bar: settings surfaces')
    } }
  },
})
