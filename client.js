/**
 * Client half of the OpenCode Go usage meter.
 *
 * Registers one composer-dock entry that renders two readings beside the
 * shipped token pills: the subscription allowance windows (5-hour / weekly /
 * monthly) and this Session's USD cost. Data comes from the Host route
 * `/opencode-go-usage/api/report`, which resolves the API key and folds the
 * durable Session log; this module only renders and schedules reads.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-opencode-go-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'opencode-go-usage'
    const API = '/opencode-go-usage/api'

    const en = {
      quotaTitle: 'OpenCode Go allowance',
      costTitle: 'Cost of this session, at OpenCode Go list prices',
      missingKey: 'API key missing',
      unavailable: 'allowance —',
      refreshHint: 'Click to refresh',
      resets: 'resets in',
      sessionCost: 'Session cost',
      sessionTokens: 'Tokens billed',
      windowRolling: '5-hour',
      windowWeekly: 'Weekly',
      windowMonthly: 'Monthly',
      unpriced: 'Model without a configured price',
      calls: 'calls',
      noData: 'no model call yet',
      updatedAt: 'updated',
      costEstimate: 'estimate from logged tokens',
      basis: 'window shares apply to the {model} monthly limit ({total})',
    }

    const pt = {
      quotaTitle: 'Limite do OpenCode Go',
      costTitle: 'Custo desta sessão, pelos preços de lista do OpenCode Go',
      missingKey: 'chave ausente',
      unavailable: 'limite —',
      refreshHint: 'Clique para atualizar',
      resets: 'renova em',
      sessionCost: 'Custo da sessão',
      sessionTokens: 'Tokens cobrados',
      windowRolling: '5 horas',
      windowWeekly: 'Semana',
      windowMonthly: 'Mês',
      unpriced: 'Modelo sem preço configurado',
      calls: 'chamadas',
      noData: 'nenhuma chamada ainda',
      updatedAt: 'Atualizado às',
      costEstimate: 'estimativa pelos tokens registrados',
      basis: 'as proporções aplicam ao limite mensal de {model} ({total})',
    }

    const SHORT = { rolling: '5h', weekly: '7d', monthly: '30d' }
    const LABEL = { rolling: 'windowRolling', weekly: 'windowWeekly', monthly: 'windowMonthly' }
    const ORDER = ['rolling', 'weekly', 'monthly']
    const SHARE = { rolling: 0.2, weekly: 0.5, monthly: 1 }

    const styles = `
      .ogq-row { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
      .ogq-pill {
        display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box;
        max-width: 100%; padding: 1px 8px; border: none; border-radius: 6px;
        background: transparent; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor));
        font: inherit; font-variant-numeric: tabular-nums; line-height: inherit; white-space: nowrap;
        font-size: calc(12px + var(--dsh-content-font-delta-secondary, 0px));
      }
      button.ogq-pill { cursor: pointer; }
      button.ogq-pill:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.14)); color: var(--dsw-alias-label-secondary, currentColor); }
      button.ogq-pill:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 1px; }
      .ogq-pill svg { width: 14px; height: 14px; flex: none; }
      .ogq-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .ogq-sep { color: var(--dsw-alias-border-l2, currentColor); margin: 0 6px; opacity: 0.8; }
      .ogq-warn { color: var(--dsw-alias-state-warn-primary, #d29922); }
      .ogq-error { color: var(--dsw-alias-state-error-primary, #f85149); }
      .ogq-dim { color: var(--dsw-alias-state-idle-primary, currentColor); opacity: 0.75; }
    `

    function percentText(percent) {
      if (percent === null || percent === undefined || !Number.isFinite(percent)) return '—'
      return `${percent >= 99.5 ? 100 : Math.round(percent)}%`
    }

    function money(usd) {
      if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—'
      if (usd === 0) return '$0.00'
      if (usd < 0.01) return '<$0.01'
      return `$${usd.toFixed(2)}`
    }

    function compactTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`
      if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
      return String(value)
    }

    function resetText(iso) {
      if (typeof iso !== 'string') return null
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return null
      const minutes = Math.max(0, Math.round((at - Date.now()) / 60000))
      if (minutes < 60) return `${minutes}min`
      const hours = Math.round(minutes / 60)
      if (hours < 48) return `${hours}h`
      return `${Math.round(hours / 24)}d`
    }

    function severityClass(percent) {
      if (percent === null || percent === undefined) return ''
      if (percent >= 95) return ' ogq-error'
      if (percent >= 70) return ' ogq-warn'
      return ''
    }

    function QuotaIcon() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('path', { d: 'M3 13a6 6 0 1 1 10 0', strokeLinecap: 'round' }),
        h('path', { d: 'M8 12.4 10.4 8.2', strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 12.6, r: 0.9, fill: 'currentColor', stroke: 'none' }))
    }

    function CostIcon() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' },
        h('path', { d: 'M4 1.9h8v11.4l-1.4-.9-1.3.9-1.3-.9-1.3.9-1.3-.9-1.4.9z' }),
        h('path', { d: 'M6.2 6h3.6M6.2 8.7h3.6', strokeLinecap: 'round' }))
    }

    function Meter(props) {
      const { sessionId, useProjection, t } = props
      const usage = useProjection('tokenUsage')
      const selection = useProjection('modelSelection')
      const [report, setReport] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const busy = React.useRef(false)
      const model = selection?.next?.model ?? selection?.lastUsed?.model ?? null
      const provider = selection?.next?.provider ?? selection?.lastUsed?.provider ?? null

      const readReport = React.useCallback(async () => {
        if (busy.current) return
        busy.current = true
        try {
          const model = selection?.next?.model ?? selection?.lastUsed?.model ?? ''
          const url = `${API}/report?sessionId=${encodeURIComponent(sessionId ?? '')}&model=${encodeURIComponent(model)}`
          const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
          const data = await response.json()
          if (response.ok && data?.ok === true) setReport(data)
          else setReport({ ok: false, error: data?.error ?? `http-${response.status}` })
        } catch (error) {
          setReport({ ok: false, error: String(error?.message ?? error) })
        } finally {
          busy.current = false
        }
      }, [sessionId, selection?.next?.model, selection?.lastUsed?.model])

      const refresh = React.useCallback(async () => {
        setRefreshing(true)
        try {
          await fetch(`${API}/refresh`, { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
        } catch {
          // The report read below surfaces the failure.
        }
        await readReport()
      }, [readReport])

      // First read, then one read per committed usage change (the projection
      // value changes when a model call settles), plus a slow backstop poll so
      // allowance windows move without any model call.
      React.useEffect(() => { void readReport() }, [usage, readReport])
      React.useEffect(() => {
        const timer = setInterval(() => { void readReport() }, 60_000)
        return () => clearInterval(timer)
      }, [readReport])

      const quota = report?.quota
      const windows = quota?.windows ?? {}
      const present = ORDER.filter((key) => windows[key] !== null && windows[key] !== undefined)
      const limitUsd = report?.limits?.monthlyLimitUsd ?? null
      const limitModel = report?.limits?.model ?? null

      const windowLine = (key) => {
        const window = windows[key]
        const reset = resetText(window.resetsAt)
        const approx = limitUsd !== null && typeof window.percent === 'number'
          ? ` · ≈ ${money((window.percent / 100) * limitUsd * SHARE[key])} / ${money(limitUsd * SHARE[key])}`
          : ''
        return `${t(LABEL[key])}: ${percentText(window.percent)}${approx}${reset === null ? '' : ` (${t('resets')} ${reset})`}`
      }

      const quotaSegments = present.map((key, index) => h(React.Fragment, { key },
        index === 0 ? null : h('span', { className: 'ogq-sep', 'aria-hidden': true }, '·'),
        h('span', { className: severityClass(windows[key].percent) }, `${SHORT[key]} ${percentText(windows[key].percent)}`)))

      const quotaTitle = [
        t('quotaTitle'),
        ...(present.length === 0
          ? [quota?.hasKey === false ? t('missingKey') : (quota?.error ?? t('unavailable'))]
          : present.map(windowLine)),
        limitUsd !== null && limitModel !== null ? t('basis', { model: limitModel, total: money(limitUsd) }) : null,
        quota?.fetchedAt === null || quota?.fetchedAt === undefined
          ? null
          : `${t('updatedAt')} ${new Date(quota.fetchedAt).toLocaleTimeString()}`,
        t('refreshHint'),
      ].filter(Boolean).join('\n')

      const session = report?.session
      const cost = typeof session?.costUsd === 'number' ? session.costUsd : null
      const tokens = session?.tokens
      const tokenTotal = tokens === null || tokens === undefined
        ? null
        : tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
      const costTitle = [
        t('costTitle'),
        `${t('sessionCost')}: ${cost === null ? '—' : money(cost)}`,
        session?.models?.map((row) => `${row.model}: ${money(row.costUsd)} · ${compactTokens(row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite)} tokens · ${row.calls} ${t('calls')}`) ?? null,
        tokenTotal === null ? null : `${t('sessionTokens')}: ${compactTokens(tokenTotal)}`,
        session?.unpricedModels?.length ? `${t('unpriced')}: ${session.unpricedModels.join(', ')}` : null,
        `${provider ?? '?'}/${model ?? '?'}`,
        t('costEstimate'),
      ].filter(Boolean).join('\n')

      const quotaPill = h('button', {
        type: 'button',
        className: 'ogq-pill',
        title: quotaTitle,
        'aria-label': quotaTitle,
        'aria-busy': refreshing ? 'true' : undefined,
        onClick: () => { void refresh() },
        'data-ogq': 'quota',
      }, h(QuotaIcon), h('span', { className: 'ogq-label' },
        present.length === 0
          ? h('span', { className: 'ogq-dim' }, quota?.hasKey === false ? t('missingKey') : t('unavailable'))
          : quotaSegments))

      const costPill = h('span', {
        className: 'ogq-pill',
        title: costTitle,
        'aria-label': costTitle,
        'data-ogq': 'cost',
      }, h(CostIcon), h('span', { className: 'ogq-label' }, cost === null ? '—' : money(cost)))

      return h(React.Fragment, null,
        h('style', null, styles),
        h('span', { className: 'ogq-row', 'data-opencode-go-usage': '' }, quotaPill, costPill))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, pt }))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'opencode-go-usage',
          order: 2,
          locale: NS,
        }, Meter))
      },
    }
  },
})
