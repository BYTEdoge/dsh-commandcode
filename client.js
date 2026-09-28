/**
 * Browser half of `dsh-commandcode`.
 *
 * Renders the CommandCode account panel as a Settings section and a compact
 * summary chip beside the sidebar foot. Both read one shared store; the Host
 * half answers it over `POST /commandcode/api/<method>`.
 *
 * Everything here is plain JavaScript: React comes from the browser module
 * table, and styling uses only `--dsw-alias-*` theme tokens so light and dark
 * follow the host.
 */

window.__ModuleLoader__.load({
  id: 'dsh-commandcode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-commandcode'

    /** Endpoint prefix registered by the Host half. */
    const API_PREFIX = '/commandcode/api'

    /** How often the panel re-reads the account while it is open. */
    const POLL_MS = 60_000

    /** A reading newer than this is reused instead of re-fetched on the poll tick. */
    const POLL_INTERVAL_MS = POLL_MS - 5_000

    /** Warm-up delay so the first paint is not blocked on a network round trip. */
    const FIRST_LOAD_DELAY_MS = 250

    const en = {
      title: 'CommandCode',
      description: 'Connect a CommandCode plan over an API key and watch its balance and usage.',
      balance: 'Balance',
      monthly: 'Monthly',
      purchased: 'Purchased',
      granted: 'Granted',
      available: 'Available',
      plan: 'Plan',
      planUnknown: 'No subscription reported',
      status: 'Status',
      renews: 'Renews',
      usage: 'Plan usage',
      fiveHour: '5 hours',
      weekly: 'Weekly',
      remaining: 'left',
      resetsIn: 'resets in',
      noWindows: 'This plan reports no rate-limit windows; the balance above is the whole budget.',
      apiKey: 'API key',
      apiKeyHint: 'Stored through the credentials service, never in the settings file.',
      apiKeySet: 'A key is configured.',
      apiKeyUnset: 'No key is configured yet.',
      apiKeyPlaceholder: 'user_…',
      save: 'Save key',
      saving: 'Saving…',
      clear: 'Forget key',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      route: 'Model route',
      routeDeclared: 'declared',
      routeMissing: 'not declared',
      routeHint: 'Writes the OpenAI-compatible route into the llm-pi-ai providers dictionary.',
      connect: 'Connect models',
      connecting: 'Connecting…',
      routeUpToDate: 'The route already matches the live catalog; nothing was written.',
      routeWritten: 'Route written: {0} models ({1} skipped because they do not serve /chat/completions).',
      routeUnchangedDetail: '{0} models available.',
      models: 'models',
      endpoint: 'Endpoint',
      updated: 'Updated',
      never: 'never',
      readOnly: 'This deployment stores credentials read-only.',
      summary: 'Summary',
      staleData: 'Showing the last successful reading.',
    }

    const zh = {
      title: 'CommandCode',
      description: '通过 API Key 连接 CommandCode 套餐，并查看余额与用量。',
      balance: '余额',
      monthly: '每月额度',
      purchased: '充值余额',
      granted: '赠送余额',
      available: '可用余额',
      plan: '套餐',
      planUnknown: '未获取到订阅信息',
      status: '状态',
      renews: '续费日',
      usage: '套餐用量',
      fiveHour: '5 小时',
      weekly: '每周',
      remaining: '剩余',
      resetsIn: '重置倒计时',
      noWindows: '该套餐没有限频窗口，上方余额即为全部额度。',
      apiKey: 'API Key',
      apiKeyHint: '通过凭据服务保存，不写入设置文件。',
      apiKeySet: '已配置密钥。',
      apiKeyUnset: '尚未配置密钥。',
      apiKeyPlaceholder: 'user_…',
      save: '保存密钥',
      saving: '保存中…',
      clear: '清除密钥',
      refresh: '刷新',
      refreshing: '刷新中…',
      route: '模型路由',
      routeDeclared: '已声明',
      routeMissing: '未声明',
      routeHint: '把 OpenAI 兼容路由写入 llm-pi-ai 的 providers 字典。',
      connect: '连接模型',
      connecting: '连接中…',
      routeUpToDate: '路由已与实时模型目录一致，未做写入。',
      routeWritten: '已写入路由：{0} 个模型（跳过 {1} 个不提供 /chat/completions 的模型）。',
      routeUnchangedDetail: '可用模型 {0} 个。',
      models: '个模型',
      endpoint: '接口地址',
      updated: '更新于',
      never: '从未',
      readOnly: '本部署的凭据为只读。',
      summary: '摘要',
      staleData: '显示的是上一次成功的读数。',
    }

    // --- formatting ---------------------------------------------------------

    /**
     * Format a credit amount.
     * @param value - USD amount.
     * @returns a `$0.00` string.
     */
    function money(value) {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
      return `$${n.toFixed(2)}`
    }

    /**
     * Count down to an ISO reset time, recomputed on every render.
     * @param iso - ISO timestamp, or null.
     * @returns `3d 4h`, `4h 12m`, `12m`, or `-`.
     */
    function countdown(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return '-'
      const target = Date.parse(iso)
      if (!Number.isFinite(target)) return '-'
      const minutes = Math.floor((target - Date.now()) / 60_000)
      if (minutes <= 0) return '-'
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${minutes % 60}m`
      return `${minutes}m`
    }

    /**
     * Format an ISO instant as a short local date and time.
     * @param iso - ISO timestamp, or null.
     * @returns a local string, or the caller's fallback.
     */
    function localTime(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return ''
      const at = new Date(iso)
      return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
    }

    /**
     * Substitute `{0}`, `{1}`, … placeholders.
     * @param template - localized template.
     * @param values - replacement values.
     * @returns the filled string.
     */
    function fill(template, values) {
      return template.replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? ''))
    }

    /**
     * Map a remaining percentage onto a theme state token.
     * @param percent - remaining percentage.
     * @returns the CSS custom property name to fill the bar with.
     */
    function barToken(percent) {
      if (percent <= 20) return '--dsw-alias-state-error-primary'
      if (percent <= 50) return '--dsw-alias-state-warn-primary'
      return '--dsw-alias-state-success-primary'
    }

    // --- transport ----------------------------------------------------------

    /**
     * Call one Host method.
     * @param method - method name under {@link API_PREFIX}.
     * @param body - JSON body.
     * @returns the method's value.
     * @throws Error carrying the Host's stable `code` when the call fails.
     */
    async function call(method, body) {
      const response = await fetch(`${API_PREFIX}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        credentials: 'same-origin',
      })
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`)
        error.code = `HTTP_${response.status}`
        throw error
      }
      const payload = await response.json()
      if (payload?.ok !== true) {
        const error = new Error(payload?.error?.message ?? 'Request failed')
        error.code = payload?.error?.code ?? 'FAILED'
        throw error
      }
      return payload.value
    }

    // --- store --------------------------------------------------------------

    /**
     * Create the shared account store.
     *
     * One object, replaced on every change, so `useSyncExternalStore` can use
     * identity as its change signal.
     *
     * @param translate - the page's locale reader, used for localized notices.
     * @returns the store and its actions.
     */
    function createStore(translate) {
      let state = {
        loading: false,
        loaded: false,
        busy: null,
        error: null,
        notice: null,
        key: { configured: false, writable: true },
        route: null,
        endpoints: null,
        snapshot: null,
        warnings: [],
      }
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener()
      }
      const set = (patch) => {
        state = { ...state, ...patch }
        emit()
      }

      /** Re-read the account and the route status together. */
      async function load() {
        set({ loading: true, error: null })
        try {
          const value = await call('usage')
          set({ snapshot: value.snapshot, warnings: value.warnings ?? [], loaded: true, loading: false })
        } catch (error) {
          set({ loading: false, error: { code: error.code, message: error.message } })
        }
      }

      /** Re-read only the parts that need no network call. */
      async function loadStatus() {
        try {
          const value = await call('status')
          set({ key: value.key, route: value.route, endpoints: value.endpoints })
        } catch (error) {
          set({ error: { code: error.code, message: error.message } })
        }
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        get: () => state,

        /** Full reload: status first so a missing key is explained before a failed balance read. */
        async refresh() {
          await loadStatus()
          await load()
        },

        /** Reload only when the previous reading is older than the poll interval. */
        refreshIfStale() {
          const fetchedAt = state.snapshot?.fetchedAt
          const at = typeof fetchedAt === 'string' ? Date.parse(fetchedAt) : Number.NaN
          if (Number.isFinite(at) && Date.now() - at < POLL_INTERVAL_MS) return
          return this.refresh()
        },

        /** Write the route from the live catalog. */
        async connect() {
          set({ busy: 'connect', error: null, notice: null })
          try {
            const value = await call('connect')
            set({
              busy: null,
              notice: value.changed
                ? { kind: 'ok', text: fill(translate('routeWritten'), [value.modelCount, value.skipped]) }
                : {
                    kind: 'ok',
                    text: `${translate('routeUpToDate')} ${fill(translate('routeUnchangedDetail'), [value.modelCount])}`,
                  },
            })
            await loadStatus()
          } catch (error) {
            set({ busy: null, error: { code: error.code, message: error.message } })
          }
        },

        /** Store a key and immediately prove it by reading the balance. */
        async saveKey(text) {
          set({ busy: 'key', error: null, notice: null })
          try {
            await call('setKey', { apiKey: text })
            await loadStatus()
            await load()
            set({ busy: null })
          } catch (error) {
            set({ busy: null, error: { code: error.code, message: error.message } })
          }
        },

        /** Forget the stored key. */
        async clearKey() {
          set({ busy: 'key', error: null, notice: null })
          try {
            await call('clearKey')
            await loadStatus()
            set({ busy: null, snapshot: null, notice: null })
          } catch (error) {
            set({ busy: null, error: { code: error.code, message: error.message } })
          }
        },
      }
    }

    // --- shared pieces ------------------------------------------------------

    /**
     * Subscribe one component to the store.
     * @param store - the shared store.
     * @returns the current state.
     */
    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    /**
     * The plugin's stylesheet, rendered inside a component so unmounting removes it.
     * Only `--dsw-alias-*` tokens are referenced, so the light and dark themes
     * both resolve.
     * @returns a style element.
     */
    function Styles() {
      return h('style', {
        key: 'dsh-commandcode-styles',
        dangerouslySetInnerHTML: {
          __html: `
.cc-root { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 24px; color: var(--dsw-alias-label-primary); }
.cc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.cc-title { font-size: 15px; font-weight: 600; margin: 0; }
.cc-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 4px 0 0; }
.cc-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 14px 16px; }
.cc-card-title { font-size: 12px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); margin: 0 0 12px; }
.cc-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 12px; }
.cc-metric-label { font-size: 11px; color: var(--dsw-alias-label-secondary); margin: 0 0 4px; }
.cc-metric-value { font-size: 18px; font-weight: 600; margin: 0; font-variant-numeric: tabular-nums; }
.cc-metric-value.is-muted { color: var(--dsw-alias-label-secondary); font-weight: 500; }
.cc-plan { font-size: 16px; font-weight: 600; margin: 0; }
.cc-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.cc-chip.is-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.cc-chip.is-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.cc-chip.is-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.cc-window + .cc-window { margin-top: 14px; }
.cc-window-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 12px; }
.cc-window-name { font-weight: 600; }
.cc-window-meta { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cc-bar { position: relative; height: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); margin-top: 6px; overflow: hidden; }
.cc-bar-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; transition: width .2s ease; }
.cc-input { flex: 1 1 auto; min-width: 0; padding: 7px 10px; font-size: 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; }
.cc-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.cc-btn { padding: 7px 12px; font-size: 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; font-family: inherit; white-space: nowrap; }
.cc-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.cc-btn:disabled { opacity: .55; cursor: default; }
.cc-btn.is-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.cc-note { font-size: 11px; color: var(--dsw-alias-label-secondary); margin: 8px 0 0; }
.cc-banner { font-size: 12px; padding: 9px 12px; border-radius: 6px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.cc-banner.is-ok { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.cc-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; }
.cc-kv dt { color: var(--dsw-alias-label-secondary); }
.cc-kv dd { margin: 0; font-variant-numeric: tabular-nums; word-break: break-all; }
.cc-foot-action { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; font-family: inherit; }
.cc-foot-action:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.cc-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.cc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`,
        },
      })
    }

    /**
     * Render the error and notice banners.
     * @param props - current error, notice and locale reader.
     * @returns the banner element, or null.
     */
    function Banners(props) {
      const { error, notice } = props
      if (error !== null && error !== undefined) {
        return h('div', { className: 'cc-banner', role: 'alert' }, error.message)
      }
      if (notice !== null && notice !== undefined) {
        return h('div', { className: 'cc-banner is-ok', role: 'status' }, notice.text)
      }
      return null
    }

    /**
     * Render one rate-limit window.
     * @param props - the window, locale reader, and whether cached data is shown.
     * @returns the window block.
     */
    function Window(props) {
      const { window: windowData, t } = props
      const percent = Math.max(0, Math.min(100, windowData.remainingPercent))
      const name = windowData.key === 'fiveHour' ? t('fiveHour') : t('weekly')
      const reset = countdown(windowData.resetAt)
      return h('div', { className: 'cc-window' }, [
        h('div', { className: 'cc-window-head', key: 'head' }, [
          h('span', { className: 'cc-window-name', key: 'name' }, `${name} · ${percent.toFixed(0)}% ${t('remaining')}`),
          h(
            'span',
            { className: 'cc-window-meta', key: 'meta' },
            `${money(windowData.remaining)} / ${money(windowData.cap)}${reset === '-' ? '' : ` · ${t('resetsIn')} ${reset}`}`,
          ),
        ]),
        h(
          'div',
          {
            className: 'cc-bar',
            key: 'bar',
            role: 'progressbar',
            'aria-valuenow': Math.round(percent),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-label': name,
          },
          h('div', {
            className: 'cc-bar-fill',
            style: { width: `${percent}%`, background: `var(${barToken(percent)})` },
          }),
        ),
      ])
    }

    // --- the Settings section ----------------------------------------------

    /**
     * The full account page.
     * @param props - owner props plus this plugin's injected store, locale and actions.
     * @returns the section element.
     */
    function UsageSection(props) {
      const { store, t } = props
      const state = useStore(store)
      const [draft, setDraft] = React.useState('')

      const configured = state.key?.configured === true
      const writable = state.key?.writable !== false
      const snapshot = state.snapshot
      const busyKey = state.busy === 'key'
      const busyConnect = state.busy === 'connect'

      const onSave = (event) => {
        event.preventDefault()
        if (draft.length === 0) return
        store.saveKey(draft).then(() => setDraft(''))
      }

      return h('div', { className: 'cc-root' }, [
        h(Styles, { key: 'styles' }),
        h('div', { className: 'cc-head', key: 'head' }, [
          h('div', { key: 'text' }, [
            h('h2', { className: 'cc-title', key: 'title' }, t('title')),
            h('p', { className: 'cc-sub', key: 'sub' }, t('description')),
          ]),
          h(
            'button',
            {
              key: 'refresh',
              type: 'button',
              className: 'cc-btn',
              disabled: state.loading,
              onClick: () => store.refresh(),
            },
            state.loading ? t('refreshing') : t('refresh'),
          ),
        ]),

        h(Banners, { key: 'banners', error: state.error, notice: state.notice }),

        h('section', { className: 'cc-card', key: 'plan' }, [
          h('h3', { className: 'cc-card-title', key: 't' }, t('plan')),
          h('div', { className: 'cc-row', key: 'row' }, [
            h('p', { className: 'cc-plan', key: 'label' }, snapshot?.plan?.planLabel ?? t('planUnknown')),
            h(
              'span',
              {
                key: 'status',
                className: `cc-chip ${snapshot?.plan?.status === 'active' ? 'is-ok' : ''}`,
              },
              snapshot?.plan?.status ?? '—',
            ),
          ]),
          snapshot?.plan?.currentPeriodEnd
            ? h('p', { className: 'cc-note', key: 'renew' }, `${t('renews')} ${localTime(snapshot.plan.currentPeriodEnd)}`)
            : null,
        ]),

        h('section', { className: 'cc-card', key: 'balance' }, [
          h('h3', { className: 'cc-card-title', key: 't' }, t('balance')),
          h('div', { className: 'cc-grid', key: 'grid' }, [
            metric(t('available'), money(snapshot?.credits?.total), false),
            metric(t('monthly'), money(snapshot?.credits?.monthly), true),
            metric(t('purchased'), money(snapshot?.credits?.purchased), true),
            metric(t('granted'), money(snapshot?.credits?.free), true),
          ]),
          snapshot !== null && snapshot !== undefined && snapshot.summary !== null
            ? h('p', { className: 'cc-note', key: 'sum' }, `${t('summary')}: ${snapshot.summary.text}`)
            : null,
        ]),

        h('section', { className: 'cc-card', key: 'usage' }, [
          h('h3', { className: 'cc-card-title', key: 't' }, t('usage')),
          snapshot === null || snapshot === undefined
            ? h('p', { className: 'cc-note', key: 'empty' }, t('staleData'))
            : snapshot.windows.length === 0
              ? h('p', { className: 'cc-note', key: 'none' }, t('noWindows'))
              : h(
                  'div',
                  { key: 'windows' },
                  snapshot.windows.map((windowData) => h(Window, { key: windowData.key, window: windowData, t })),
                ),
          (state.warnings ?? []).map((warning, index) =>
            h('p', { className: 'cc-note', key: `warn-${index}` }, warning.message),
          ),
        ]),

        h('section', { className: 'cc-card', key: 'key' }, [
          h('h3', { className: 'cc-card-title', key: 't' }, t('apiKey')),
          h(
            'form',
            { className: 'cc-row', key: 'form', onSubmit: onSave },
            [
              h('input', {
                key: 'input',
                className: 'cc-input',
                type: 'password',
                name: 'commandcode-api-key',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: configured ? '••••••••' : t('apiKeyPlaceholder'),
                value: draft,
                disabled: !writable || busyKey,
                onChange: (event) => setDraft(event.target.value),
                'aria-label': t('apiKey'),
              }),
              h(
                'button',
                { key: 'save', type: 'submit', className: 'cc-btn is-primary', disabled: !writable || busyKey || draft.length === 0 },
                busyKey ? t('saving') : t('save'),
              ),
              configured && writable
                ? h(
                    'button',
                    { key: 'clear', type: 'button', className: 'cc-btn', disabled: busyKey, onClick: () => store.clearKey() },
                    t('clear'),
                  )
                : null,
            ],
          ),
          h('p', { className: 'cc-note', key: 'hint' }, `${configured ? t('apiKeySet') : t('apiKeyUnset')} ${t('apiKeyHint')}`),
          writable ? null : h('p', { className: 'cc-note', key: 'ro' }, t('readOnly')),
        ]),

        h('section', { className: 'cc-card', key: 'route' }, [
          h('div', { className: 'cc-row', key: 'head' }, [
            h('h3', { className: 'cc-card-title', key: 't', style: { margin: 0 } }, t('route')),
            h(
              'span',
              { key: 'chip', className: `cc-chip ${state.route?.declared ? 'is-ok' : 'is-warn'}` },
              `${state.route?.declared ? t('routeDeclared') : t('routeMissing')}${state.route?.modelCount ? ` · ${state.route.modelCount} ${t('models')}` : ''}`,
            ),
          ]),
          h('dl', { className: 'cc-kv', key: 'kv', style: { marginTop: 12 } }, [
            h('dt', { key: 'rk' }, 'route'),
            h('dd', { key: 'rv' }, state.route?.routeKey ?? '—'),
            h('dt', { key: 'ek' }, t('endpoint')),
            h('dd', { key: 'ev' }, state.route?.baseURL ?? state.endpoints?.providerBaseUrl ?? '—'),
            h('dt', { key: 'kk' }, t('apiKey')),
            h('dd', { key: 'kv2' }, state.route?.apiKeyRef ?? '—'),
          ]),
          h('p', { className: 'cc-note', key: 'hint' }, t('routeHint')),
          h('div', { className: 'cc-row', key: 'actions', style: { marginTop: 10, justifyContent: 'flex-start', gap: 8 } }, [
            h(
              'button',
              {
                key: 'connect',
                type: 'button',
                className: 'cc-btn is-primary',
                disabled: busyConnect || !configured,
                onClick: () => store.connect(),
              },
              busyConnect ? t('connecting') : t('connect'),
            ),
          ]),
        ]),

        h(
          'p',
          { className: 'cc-note', key: 'updated' },
          `${t('updated')} ${snapshot?.fetchedAt ? localTime(snapshot.fetchedAt) : t('never')}`,
        ),
      ])
    }

    /**
     * Render one balance metric.
     * @param label - metric label.
     * @param value - formatted value.
     * @param muted - whether this metric is secondary.
     * @returns the metric block.
     */
    function metric(label, value, muted) {
      return h('div', { key: label }, [
        h('p', { className: 'cc-metric-label', key: 'l' }, label),
        h('p', { className: `cc-metric-value${muted ? ' is-muted' : ''}`, key: 'v' }, value),
      ])
    }

    // --- the sidebar chip ---------------------------------------------------

    /**
     * Compact account summary beside the sidebar foot.
     * @param props - owner props plus this plugin's injected store and locale.
     * @returns the chip element.
     */
    function FooterChip(props) {
      const { store, t, wide } = props
      const state = useStore(store)
      const snapshot = state.snapshot
      const percent = snapshot?.summary?.primaryRemainingPercent
      const token = typeof percent === 'number' ? barToken(percent) : '--dsw-alias-state-idle-primary'
      const label = snapshot?.summary?.text ?? '—'
      const title =
        snapshot === null || snapshot === undefined
          ? `${t('title')} · ${state.error?.message ?? t('apiKeyUnset')}`
          : `${snapshot.plan?.planLabel ?? t('title')} · ${label}`

      return h(
        'button',
        {
          type: 'button',
          className: 'cc-foot-action',
          title,
          'aria-label': title,
          onClick: () => store.refresh(),
        },
        [
          h('span', { className: 'cc-dot', key: 'dot', style: { background: `var(${token})` } }),
          wide ? h('span', { key: 'text' }, label) : h('span', { className: 'cc-sr', key: 'text' }, label),
        ],
      )
    }

    // --- plugin -------------------------------------------------------------

    const inject = ['slots', 'locale']

    /**
     * Mount the panel and the chip.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-commandcode: dictionaries')
      const t = ctx.locale.bind(NS)

      const store = createStore(t)

      ctx.effect(() => {
        const first = setTimeout(() => {
          store.refresh()
        }, FIRST_LOAD_DELAY_MS)
        const poll = setInterval(() => {
          store.refreshIfStale()
        }, POLL_MS)
        return () => {
          clearTimeout(first)
          clearInterval(poll)
        }
      }, 'dsh-commandcode: account polling')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-commandcode',
            order: 35,
            label: () => t('title'),
            inject: () => ({ store, t }),
          },
          UsageSection,
        ),
      )

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-commandcode',
            order: 20,
            label: () => t('title'),
            inject: () => ({ store, t }),
          },
          FooterChip,
        ),
      )
    }

    return { inject, apply, NS }
  },
})
