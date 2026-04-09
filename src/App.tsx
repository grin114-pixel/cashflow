import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import './App.css'
import { getSupabaseClient, isSupabaseConfigured } from './lib/supabase'
import { hashPin } from './lib/pin'
import type { CashFlowCard, SubCard, Row } from './lib/supabase'

const AUTH_STORAGE_KEY = 'cashflow.remembered-auth'
const PIN_HASH_STORAGE_KEY = 'cashflow.pin-hash'
const DEFAULT_PIN = '1234'
const SETTINGS_ROW_ID = 'global'

type View = 'main' | 'detail'

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return '요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'
}

function makeEmptyRow(): Row {
  return {
    id: crypto.randomUUID(),
    label: '',
    amount: 0,
    sort_order: 0,
    excluded: false,
    memo: '',
    locked: false,
    boxed: false,
  }
}

function makeDefaultRows(count = 5): Row[] {
  return Array.from({ length: count }, (_, i) => ({ ...makeEmptyRow(), sort_order: i }))
}

function calcSummary(subCards: SubCard[]) {
  let income = 0
  let expense = 0

  for (const sc of subCards) {
    const isIncomeTable = (sc.name ?? '').trim() === '수입'
    for (const row of sc.rows ?? []) {
      if (row.excluded) continue
      const amt = Number(row.amount) || 0
      if (amt === 0) continue

      if (isIncomeTable) income += amt
      else expense += Math.abs(amt)
    }
  }

  return { income, expense, balance: income - expense }
}

function formatAmount(n: number) {
  if (n === 0) return '0'
  return n.toLocaleString()
}

function pickLatestCard(cards: CashFlowCard[]) {
  if (cards.length === 0) return null
  const sorted = [...cards].sort((a, b) => {
    const aCreated = new Date((a as any).created_at ?? 0).getTime()
    const bCreated = new Date((b as any).created_at ?? 0).getTime()
    if (aCreated && bCreated && aCreated !== bCreated) return bCreated - aCreated
    return (b.sort_order ?? 0) - (a.sort_order ?? 0)
  })
  return sorted[0] ?? null
}

function copyLockedRowsOnly(sourceRows: Row[]): Row[] {
  const lockedRows = (sourceRows ?? []).filter((r) => Boolean(r.locked))
  return lockedRows.map((r, idx) => ({
    id: crypto.randomUUID(),
    label: r.label ?? '',
    amount: r.boxed ? 0 : (Number(r.amount) || 0),
    sort_order: idx,
    excluded: Boolean(r.excluded),
    memo: r.memo ?? '',
    locked: true,
    boxed: Boolean(r.boxed),
  }))
}

// ────────────────────────────────────────────────────────────
// ConfirmDialog
// ────────────────────────────────────────────────────────────
function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '확인',
  cancelLabel = '취소',
  onConfirm,
  onCancel,
}: {
  open: boolean
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {title ? <h2 className="modal-title">{title}</h2> : null}
        <p style={{ margin: 0, color: '#334155', fontWeight: 700 }}>{message}</p>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="primary-button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// MemoDialog
// ────────────────────────────────────────────────────────────
function MemoDialog({
  open,
  value,
  onChange,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean
  value: string
  onChange: (next: string) => void
  onClose: () => void
  onSave: () => void
  onDelete: () => void
}) {
  if (!open) return null
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <h2 className="modal-title" style={{ margin: 0 }}>메모</h2>
          <button type="button" className="icon-chip icon-chip--danger" aria-label="메모 삭제" onClick={onDelete}>
            <TrashIcon />
          </button>
        </div>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="메모를 입력하세요"
          style={{
            width: '100%',
            minHeight: 180,
            marginTop: 10,
            resize: 'vertical',
            borderRadius: 12,
            border: '1px solid #e2d5a0',
            padding: '10px 12px',
            fontSize: 14,
            lineHeight: 1.5,
            outline: 'none',
          }}
          autoFocus
        />
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>닫기</button>
          <button type="button" className="primary-button" onClick={onSave}>저장</button>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// App
// ────────────────────────────────────────────────────────────
function App() {
  // ── auth state ──
  const [isCheckingAuth, setIsCheckingAuth] = useState(true)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(false)
  const [pin, setPin] = useState('')
  const [authError, setAuthError] = useState('')
  const [isChangingPin, setIsChangingPin] = useState(false)
  const [currentPinInput, setCurrentPinInput] = useState('')
  const [newPinInput, setNewPinInput] = useState('')
  const [pinChangeError, setPinChangeError] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [dataError, setDataError] = useState('')

  // ── data state ──
  const [cashFlowCards, setCashFlowCards] = useState<CashFlowCard[]>([])
  const [subCardsByCardId, setSubCardsByCardId] = useState<Record<string, SubCard[]>>({})
  const [isLoadingCards, setIsLoadingCards] = useState(false)

  // ── navigation state ──
  const [view, setView] = useState<View>('main')
  const [activeCardId, setActiveCardId] = useState<string | null>(null)

  // ── create modals ──
  const [showCreateCashFlowModal, setShowCreateCashFlowModal] = useState(false)
  const [newCashFlowName, setNewCashFlowName] = useState('')
  const [createCashFlowError, setCreateCashFlowError] = useState('')
  const [isCreatingCashFlow, setIsCreatingCashFlow] = useState(false)
  const [showCreateSubCardModal, setShowCreateSubCardModal] = useState(false)
  const [newSubCardName, setNewSubCardName] = useState('')
  const [createSubCardError, setCreateSubCardError] = useState('')
  const [isCreatingSubCard, setIsCreatingSubCard] = useState(false)

  // ── confirm dialog ──
  const [confirmState, setConfirmState] = useState<{
    open: boolean
    message: string
    title?: string
    confirmLabel?: string
    cancelLabel?: string
  }>({ open: false, message: '' })
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null)

  const saveTimers = useRef<Record<string, number>>({})
  const lastSavedJson = useRef<Record<string, string>>({})

  const defaultPin = String(import.meta.env.VITE_APP_PIN ?? DEFAULT_PIN).trim()
  const supabaseReady = isSupabaseConfigured()
  const defaultPinHashPromise = useMemo(() => hashPin(defaultPin), [defaultPin])

  const activeCard = useMemo(
    () => (activeCardId ? cashFlowCards.find((c) => c.id === activeCardId) ?? null : null),
    [cashFlowCards, activeCardId],
  )

  const activeSubCards = useMemo(
    () => (activeCardId ? (subCardsByCardId[activeCardId] ?? []) : []),
    [subCardsByCardId, activeCardId],
  )

  const latestCard = useMemo(() => pickLatestCard(cashFlowCards), [cashFlowCards])

  const latestSubCards = useMemo(() => {
    if (!latestCard) return []
    return subCardsByCardId[latestCard.id] ?? []
  }, [latestCard, subCardsByCardId])

  const cardsInCreatedOrder = useMemo(() => {
    if (cashFlowCards.length === 0) return []
    return [...cashFlowCards].sort((a, b) => {
      const aCreated = new Date((a as any).created_at ?? 0).getTime()
      const bCreated = new Date((b as any).created_at ?? 0).getTime()
      if (aCreated && bCreated && aCreated !== bCreated) return aCreated - bCreated
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    })
  }, [cashFlowCards])

  const previousCards = useMemo(() => {
    if (!latestCard) return cardsInCreatedOrder
    return cardsInCreatedOrder.filter((c) => c.id !== latestCard.id)
  }, [cardsInCreatedOrder, latestCard])

  const previousCardsRecentFirst = useMemo(() => {
    return [...previousCards].sort((a, b) => {
      const aCreated = new Date((a as any).created_at ?? 0).getTime()
      const bCreated = new Date((b as any).created_at ?? 0).getTime()
      if (aCreated && bCreated && aCreated !== bCreated) return bCreated - aCreated
      return (b.sort_order ?? 0) - (a.sort_order ?? 0)
    })
  }, [previousCards])

  // ── auth check ──
  useEffect(() => {
    const remembered = window.localStorage.getItem(AUTH_STORAGE_KEY) === 'true'
    setRememberDevice(remembered)
    setIsAuthenticated(remembered)
    setIsCheckingAuth(false)
  }, [])

  // ── status toast ──
  useEffect(() => {
    if (!statusMessage) return
    const id = window.setTimeout(() => setStatusMessage(''), 2500)
    return () => window.clearTimeout(id)
  }, [statusMessage])

  // ── scroll to top when navigating ──
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [view, activeCardId])

  // ── pin helpers ──
  const ensureRemotePinHash = useCallback(async () => {
    const fallback = await defaultPinHashPromise
    if (!supabaseReady) return fallback
    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from('cashflow_app_settings')
      .select('pin_hash')
      .eq('id', SETTINGS_ROW_ID)
      .maybeSingle()
    if (error) throw error
    if (data?.pin_hash) return data.pin_hash
    const { error: upsertError } = await supabase
      .from('cashflow_app_settings')
      .upsert({ id: SETTINGS_ROW_ID, pin_hash: fallback })
    if (upsertError) throw upsertError
    return fallback
  }, [defaultPinHashPromise, supabaseReady])

  const resolveExpectedPinHash = useCallback(async () => {
    try {
      const remote = await ensureRemotePinHash()
      window.localStorage.setItem(PIN_HASH_STORAGE_KEY, remote)
      return remote
    } catch {
      const saved = window.localStorage.getItem(PIN_HASH_STORAGE_KEY)
      if (saved) return saved
      return defaultPinHashPromise
    }
  }, [defaultPinHashPromise, ensureRemotePinHash])

  // ── load all data ──
  const loadAllData = useCallback(async () => {
    if (!supabaseReady) {
      setDataError('Supabase 환경 변수가 설정되지 않았어요.')
      return
    }
    setIsLoadingCards(true)
    setDataError('')
    try {
      const supabase = getSupabaseClient()
      const [cardsResult, subCardsResult] = await Promise.all([
        supabase.from('cashflow_cards').select('*').order('sort_order', { ascending: true }),
        supabase.from('cashflow_sub_cards').select('*').order('sort_order', { ascending: true }),
      ])
      if (cardsResult.error) throw cardsResult.error
      if (subCardsResult.error) throw subCardsResult.error
      setCashFlowCards((cardsResult.data ?? []) as CashFlowCard[])
      const grouped: Record<string, SubCard[]> = {}
      for (const sc of (subCardsResult.data ?? []) as SubCard[]) {
        if (!grouped[sc.cashflow_card_id]) grouped[sc.cashflow_card_id] = []
        grouped[sc.cashflow_card_id].push(sc)
      }
      setSubCardsByCardId(grouped)
    } catch (error) {
      setDataError(getErrorMessage(error))
    } finally {
      setIsLoadingCards(false)
    }
  }, [supabaseReady])

  useEffect(() => {
    if (!isAuthenticated) {
      setCashFlowCards([])
      setSubCardsByCardId({})
      return
    }
    void loadAllData()
  }, [isAuthenticated, loadAllData])

  // ── pin submit ──
  async function handlePinSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pin.length !== 4) { setAuthError('PIN 4자리를 입력해 주세요.'); return }
    try {
      const expected = await resolveExpectedPinHash()
      const input = await hashPin(pin)
      if (input !== expected) { setAuthError('입력한 PIN이 일치하지 않습니다.'); return }
    } catch {
      setAuthError('PIN 확인 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.')
      return
    }
    if (rememberDevice) window.localStorage.setItem(AUTH_STORAGE_KEY, 'true')
    else window.localStorage.removeItem(AUTH_STORAGE_KEY)
    setAuthError('')
    setPin('')
    setIsAuthenticated(true)
  }

  async function handlePinChangeSave() {
    setPinChangeError('')
    if (currentPinInput.length !== 4) { setPinChangeError('현재 PIN 4자리를 입력해 주세요.'); return }
    if (newPinInput.length !== 4) { setPinChangeError('새 PIN 4자리를 입력해 주세요.'); return }
    try {
      const expected = await resolveExpectedPinHash()
      const current = await hashPin(currentPinInput)
      if (current !== expected) { setPinChangeError('현재 PIN이 일치하지 않습니다.'); return }
      const next = await hashPin(newPinInput)
      if (supabaseReady) {
        const supabase = getSupabaseClient()
        const { error } = await supabase
          .from('cashflow_app_settings')
          .upsert({ id: SETTINGS_ROW_ID, pin_hash: next })
        if (error) throw error
      }
      window.localStorage.setItem(PIN_HASH_STORAGE_KEY, next)
      window.localStorage.removeItem(AUTH_STORAGE_KEY)
      setRememberDevice(false)
      setIsAuthenticated(false)
      setIsChangingPin(false)
      setCurrentPinInput('')
      setNewPinInput('')
      setPin('')
      setAuthError('')
      setStatusMessage('PIN을 변경했어요. 다시 로그인해 주세요.')
    } catch (error) {
      setPinChangeError(getErrorMessage(error))
    }
  }

  function handlePinDigits(setter: (v: string) => void, e: ChangeEvent<HTMLInputElement>) {
    setter(e.target.value.replace(/\D/g, '').slice(0, 4))
  }

  function handlePinChange(e: ChangeEvent<HTMLInputElement>) {
    setPin(e.target.value.replace(/\D/g, '').slice(0, 4))
    if (authError) setAuthError('')
  }

  function handleLock() {
    window.localStorage.removeItem(AUTH_STORAGE_KEY)
    setRememberDevice(false)
    setPin('')
    setIsAuthenticated(false)
    setView('main')
    setActiveCardId(null)
  }

  // ── create cashflow card ──
  async function handleCreateCashFlowCard(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const name = newCashFlowName.trim()
    if (!name) {
      setCreateCashFlowError('카드 이름을 입력해 주세요.')
      return
    }
    if (!supabaseReady) {
      setCreateCashFlowError('Supabase가 설정되지 않았어요.')
      setDataError('Supabase가 설정되지 않았어요.')
      return
    }

    // source = "just before creating a new card"
    const sourceCard = pickLatestCard(cashFlowCards)
    const sourceSubCards = sourceCard ? (subCardsByCardId[sourceCard.id] ?? []) : []

    try {
      setIsCreatingCashFlow(true)
      setCreateCashFlowError('')
      const supabase = getSupabaseClient()
      const nextOrder = cashFlowCards.length
      const { data, error } = await supabase
        .from('cashflow_cards')
        .insert({ name, sort_order: nextOrder })
        .select('*')
        .single()
      if (error) throw error
      const created = data as CashFlowCard
      setCashFlowCards((prev) => [...prev, created])
      setNewCashFlowName('')
      setShowCreateCashFlowModal(false)

      // Copy locked rows from previous card -> new card
      const normalizedSource = [...sourceSubCards].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))

      const pickSourceByName = (n: string) => normalizedSource.find((s) => (s.name ?? '').trim() === n) ?? null

      const incomeSource = pickSourceByName('수입')
      const fixedSource = pickSourceByName('고정 이벤트')
      const oneTimeSource = pickSourceByName('일회성 이벤트')

      const payloads: Array<{ cashflow_card_id: string; name: string; sort_order: number; rows: Row[] }> = []
      const usedNames = new Set<string>()

      // 1) Always create 수입 table first (carry locked rows if any, plus padding)
      const incomeCopied = copyLockedRowsOnly(incomeSource?.rows ?? [])
      payloads.push({
        cashflow_card_id: created.id,
        name: '수입',
        sort_order: payloads.length,
        rows: incomeCopied.length > 0 ? incomeCopied : makeDefaultRows(5),
      })
      usedNames.add('수입')

      // 2) Always create 고정 이벤트 / 일회성 이벤트 under 수입 (even with no locks)
      const fixedCopied = copyLockedRowsOnly(fixedSource?.rows ?? [])
      payloads.push({
        cashflow_card_id: created.id,
        name: '고정 이벤트',
        sort_order: payloads.length,
        rows: fixedCopied.length > 0 ? fixedCopied : makeDefaultRows(5),
      })
      usedNames.add('고정 이벤트')

      const oneTimeCopied = copyLockedRowsOnly(oneTimeSource?.rows ?? [])
      payloads.push({
        cashflow_card_id: created.id,
        name: '일회성 이벤트',
        sort_order: payloads.length,
        rows: oneTimeCopied.length > 0 ? oneTimeCopied : makeDefaultRows(5),
      })
      usedNames.add('일회성 이벤트')

      // 3) For the rest, only carry over tables that have locked rows
      for (const sc of normalizedSource) {
        const name = (sc.name ?? '').trim()
        if (!name) continue
        if (usedNames.has(name)) continue
        const copied = copyLockedRowsOnly(sc.rows ?? [])
        if (copied.length === 0) continue
        payloads.push({
          cashflow_card_id: created.id,
          name,
          sort_order: payloads.length,
          rows: copied,
        })
        usedNames.add(name)
      }

      if (payloads.length > 0) {
        const { data: insertedSubCards, error: insertSubError } = await supabase
          .from('cashflow_sub_cards')
          .insert(payloads)
          .select('*')

        if (insertSubError) throw insertSubError

        const inserted = (insertedSubCards ?? []) as SubCard[]
        setSubCardsByCardId((prev) => ({
          ...prev,
          [created.id]: inserted.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
        }))
      }
    } catch (error) {
      const msg = getErrorMessage(error)
      setDataError(msg)
      setCreateCashFlowError(msg)
    } finally {
      setIsCreatingCashFlow(false)
    }
  }

  // ── delete cashflow card ──
  async function handleDeleteCashFlowCard(card: CashFlowCard, e: React.MouseEvent) {
    e.stopPropagation()
    const ok = await askConfirm(`"${card.name}" 카드를 삭제할까요?\n세부 목록도 모두 삭제됩니다.`)
    if (!ok) return
    try {
      const supabase = getSupabaseClient()
      await supabase.from('cashflow_sub_cards').delete().eq('cashflow_card_id', card.id)
      const { error } = await supabase.from('cashflow_cards').delete().eq('id', card.id)
      if (error) throw error
      if (activeCardId === card.id) {
        setView('main')
        setActiveCardId(null)
      }
      await loadAllData()
    } catch (error) {
      setDataError(getErrorMessage(error))
    }
  }

  // ── navigate to detail ──
  function navigateToDetail(cardId: string) {
    setActiveCardId(cardId)
    setView('detail')
  }

  function navigateToMain() {
    setView('main')
    setActiveCardId(null)
  }

  // ── move sub card (detail: reorder excel cards) ──
  async function moveActiveSubCard(subCardId: string, direction: 'up' | 'down') {
    if (!activeCardId) return
    const list = subCardsByCardId[activeCardId] ?? []
    const fromIndex = list.findIndex((sc) => sc.id === subCardId)
    if (fromIndex < 0) return
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1
    if (toIndex < 0 || toIndex >= list.length) return

    const next = [...list]
    const tmp = next[toIndex]
    next[toIndex] = next[fromIndex]
    next[fromIndex] = tmp
    const nextWithOrder = next.map((sc, i) => ({ ...sc, sort_order: i }))

    // optimistic UI
    setSubCardsByCardId((prev) => ({ ...prev, [activeCardId]: nextWithOrder }))

    if (!supabaseReady) return

    try {
      const supabase = getSupabaseClient()
      const a = nextWithOrder[toIndex]
      const b = nextWithOrder[fromIndex]
      const { error: errA } = await supabase.from('cashflow_sub_cards').update({ sort_order: a.sort_order }).eq('id', a.id)
      if (errA) throw errA
      const { error: errB } = await supabase.from('cashflow_sub_cards').update({ sort_order: b.sort_order }).eq('id', b.id)
      if (errB) throw errB
    } catch (error) {
      const msg = getErrorMessage(error)
      setDataError(msg)
      // revert on failure
      setSubCardsByCardId((prev) => ({ ...prev, [activeCardId]: list }))
    }
  }

  // ── create sub card ──
  async function handleCreateSubCard(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const name = newSubCardName.trim()
    if (!activeCardId) {
      setCreateSubCardError('카드를 선택해 주세요.')
      return
    }
    if (!name) {
      setCreateSubCardError('카드 이름을 입력해 주세요.')
      return
    }
    if (!supabaseReady) {
      setCreateSubCardError('Supabase가 설정되지 않았어요.')
      setDataError('Supabase가 설정되지 않았어요.')
      return
    }
    try {
      setIsCreatingSubCard(true)
      setCreateSubCardError('')
      const supabase = getSupabaseClient()
      const existing = subCardsByCardId[activeCardId] ?? []
      const nextOrder = existing.length
      const defaultRows = makeDefaultRows(5)
      const { data, error } = await supabase
        .from('cashflow_sub_cards')
        .insert({
          cashflow_card_id: activeCardId,
          name,
          sort_order: nextOrder,
          rows: defaultRows,
        })
        .select('*')
        .single()
      if (error) throw error
      const created = data as SubCard
      setSubCardsByCardId((prev) => ({
        ...prev,
        [activeCardId]: [...(prev[activeCardId] ?? []), created],
      }))
      setNewSubCardName('')
      setShowCreateSubCardModal(false)
    } catch (error) {
      const msg = getErrorMessage(error)
      setDataError(msg)
      setCreateSubCardError(msg)
    } finally {
      setIsCreatingSubCard(false)
    }
  }

  // ── delete sub card ──
  async function handleDeleteSubCard(subCard: SubCard) {
    const ok = await askConfirm(`"${subCard.name}" 카드를 삭제할까요?`)
    if (!ok) return
    try {
      const supabase = getSupabaseClient()
      const { error } = await supabase.from('cashflow_sub_cards').delete().eq('id', subCard.id)
      if (error) throw error
      await loadAllData()
    } catch (error) {
      setDataError(getErrorMessage(error))
    }
  }

  // ── confirm helper ──
  function askConfirm(message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string }) {
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve
      setConfirmState({ open: true, message, title: options?.title, confirmLabel: options?.confirmLabel, cancelLabel: options?.cancelLabel })
    })
  }

  // ── schedule row save ──
  function scheduleRowSave(subCardId: string, rows: Row[]) {
    if (!supabaseReady) return
    if (saveTimers.current[subCardId]) window.clearTimeout(saveTimers.current[subCardId])
    saveTimers.current[subCardId] = window.setTimeout(async () => {
      const json = JSON.stringify(rows)
      if (json === lastSavedJson.current[subCardId]) return
      try {
        const supabase = getSupabaseClient()
        const { error } = await supabase.from('cashflow_sub_cards').update({ rows }).eq('id', subCardId)
        if (error) throw error
        lastSavedJson.current[subCardId] = json
      } catch (error) {
        console.error('rows save error:', error)
      }
    }, 600)
  }

  function updateSubCardRows(subCardId: string, cashflowCardId: string, updater: (prev: Row[]) => Row[]) {
    setSubCardsByCardId((prev) => {
      const cards = prev[cashflowCardId] ?? []
      const next = cards.map((sc) => {
        if (sc.id !== subCardId) return sc
        const nextRows = updater(sc.rows)
        scheduleRowSave(subCardId, nextRows)
        return { ...sc, rows: nextRows }
      })
      return { ...prev, [cashflowCardId]: next }
    })
  }

  // ── render: checking auth ──
  if (isCheckingAuth) {
    return (
      <div className="auth-shell">
        <div className="pin-card">
          <p className="pin-subtitle">Cash Flow를 준비하는 중...</p>
        </div>
      </div>
    )
  }

  // ── render: login ──
  if (!isAuthenticated) {
    return (
      <div className="auth-shell">
        <form className="pin-card" onSubmit={handlePinSubmit}>
          {isChangingPin ? (
            <>
              <h1>PIN 변경하기</h1>
              <div className="pin-change-panel">
                <label className="field">
                  <span>현재 PIN</span>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="현재 PIN"
                    value={currentPinInput}
                    onChange={(e) => handlePinDigits(setCurrentPinInput, e)}
                  />
                </label>
                <label className="field">
                  <span>새 PIN</span>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    placeholder="새 PIN"
                    value={newPinInput}
                    onChange={(e) => handlePinDigits(setNewPinInput, e)}
                  />
                </label>
                {pinChangeError ? <p className="error-text">{pinChangeError}</p> : null}
                <button type="button" className="secondary-button" onClick={() => void handlePinChangeSave()}>
                  PIN 저장
                </button>
                <button type="button" className="text-button" onClick={() => setIsChangingPin(false)}>
                  로그인으로 돌아가기
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="app-badge">
                <CashFlowIcon />
                <span>Cash Flow</span>
              </div>
              <div className="pin-entry-field">
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                  placeholder="0000"
                  aria-label="4자리 숫자 입력"
                  value={pin}
                  onChange={handlePinChange}
                  className="pin-entry-input"
                />
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={rememberDevice}
                  onChange={(e) => setRememberDevice(e.target.checked)}
                />
                <span>이 기기 기억하기</span>
              </label>
              {authError ? <p className="error-text">{authError}</p> : null}
              <button type="submit" className="primary-button">입장하기</button>
              <button
                type="button"
                className="text-button pin-change-button"
                onClick={() => {
                  setIsChangingPin(true)
                  setPinChangeError('')
                  setCurrentPinInput('')
                  setNewPinInput('')
                }}
              >
                PIN 변경하기
              </button>
            </>
          )}
        </form>
      </div>
    )
  }

  // ── render: detail view ──
  if (view === 'detail' && activeCard) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <button type="button" className="back-button" onClick={navigateToMain}>
            <BackIcon />
            목록
          </button>
          <div className="detail-topbar-center">
            <h1>{activeCard.name}</h1>
          </div>
          <div className="topbar-actions">
            <button type="button" className="secondary-button lock-button" aria-label="잠금" onClick={handleLock}>
              <LockIcon />
            </button>
          </div>
        </header>

        {!supabaseReady ? (
          <section className="notice-card">
            <h2>Supabase 연결이 필요해요</h2>
            <p>`.env`에 URL, Anon Key, PIN 값을 넣은 뒤 다시 실행해 주세요.</p>
          </section>
        ) : null}

        {dataError ? (
          <section className="notice-card error-card">
            <h2>처리 중 문제가 생겼어요</h2>
            <p>{dataError}</p>
          </section>
        ) : null}

        {statusMessage ? <div className="toast-message">{statusMessage}</div> : null}

        <main className="content-area">
          {isLoadingCards ? (
            <div className="empty-state"><p>불러오는 중...</p></div>
          ) : activeSubCards.length === 0 ? (
            <div className="empty-state">
              <div className="empty-illustration"><CashFlowIcon /></div>
              <h2>세부 목록이 없어요</h2>
              <p>아래 + 버튼을 눌러 첫 번째 카드를 만들어 보세요.</p>
            </div>
          ) : (
            <div className="sub-card-list">
              {activeSubCards.map((subCard) => (
                <SubCardComponent
                  key={subCard.id}
                  subCard={subCard}
                  onDelete={() => void handleDeleteSubCard(subCard)}
                  onUpdateRows={(updater) => updateSubCardRows(subCard.id, activeCard.id, updater)}
                  onMoveUp={() => void moveActiveSubCard(subCard.id, 'up')}
                  onMoveDown={() => void moveActiveSubCard(subCard.id, 'down')}
                  askConfirm={askConfirm}
                />
              ))}
            </div>
          )}
        </main>

        <button
          type="button"
          className="fab"
          aria-label="새 카드 추가"
        onClick={() => {
          setCreateSubCardError('')
          setShowCreateSubCardModal(true)
        }}
        >
          <PlusIcon />
        </button>

        {showCreateSubCardModal ? (
          <div className="modal-overlay" onClick={() => setShowCreateSubCardModal(false)}>
            <form
              className="modal-card"
              onClick={(e) => e.stopPropagation()}
              onSubmit={handleCreateSubCard}
            >
              <h2 className="modal-title">새 항목 만들기</h2>
              <label className="field">
                <input
                  type="text"
                  value={newSubCardName}
                  onChange={(e) => setNewSubCardName(e.target.value)}
                  autoFocus
                />
              </label>
              {createSubCardError ? <p className="error-text">{createSubCardError}</p> : null}
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setShowCreateSubCardModal(false)}>
                  취소
                </button>
                <button type="submit" className="primary-button" disabled={!newSubCardName.trim() || isCreatingSubCard}>
                  만들기
                </button>
              </div>
            </form>
          </div>
        ) : null}

        <ConfirmDialog
          open={confirmState.open}
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          cancelLabel={confirmState.cancelLabel}
          onCancel={() => {
            setConfirmState((prev) => ({ ...prev, open: false }))
            confirmResolverRef.current?.(false)
            confirmResolverRef.current = null
          }}
          onConfirm={() => {
            setConfirmState((prev) => ({ ...prev, open: false }))
            confirmResolverRef.current?.(true)
            confirmResolverRef.current = null
          }}
        />
      </div>
    )
  }

  // ── render: main view ──
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-title">
          <div className="app-icon">
            <CashFlowIcon />
          </div>
          <h1>Cash Flow</h1>
        </div>
        <div className="topbar-actions">
          <button type="button" className="secondary-button lock-button" aria-label="잠금" onClick={handleLock}>
            <LockIcon />
          </button>
        </div>
      </header>

      {!supabaseReady ? (
        <section className="notice-card">
          <h2>Supabase 연결이 필요해요</h2>
          <p>`.env`에 URL, Anon Key, PIN 값을 넣은 뒤 다시 실행해 주세요.</p>
        </section>
      ) : null}

      {dataError ? (
        <section className="notice-card error-card">
          <h2>처리 중 문제가 생겼어요</h2>
          <p>{dataError}</p>
        </section>
      ) : null}

      {statusMessage ? <div className="toast-message">{statusMessage}</div> : null}

      <main className="content-area">
        {isLoadingCards ? (
          <div className="empty-state"><p>카드 목록을 불러오는 중...</p></div>
        ) : cashFlowCards.length === 0 ? (
          <div className="empty-state">
            <div className="empty-illustration"><CashFlowIcon /></div>
            <h2>아직 카드가 없어요</h2>
            <p>아래 + 버튼을 눌러 첫 번째 카드를 만들어 보세요.</p>
          </div>
        ) : (
          <>
            {/* 1) Latest card under header */}
            {latestCard ? (
              <div className="cashflow-card-list">
                {(() => {
                  const subCards = subCardsByCardId[latestCard.id] ?? []
                  const { income, expense, balance } = calcSummary(subCards)
                  return (
                    <div
                      key={latestCard.id}
                      className="cashflow-summary-card cashflow-summary-card--latest"
                      onClick={() => navigateToDetail(latestCard.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') navigateToDetail(latestCard.id)
                      }}
                    >
                      <div className="cashflow-card-header">
                        <p className="cashflow-card-name">{latestCard.name}</p>
                        <button
                          type="button"
                          className="cashflow-card-delete-btn"
                          aria-label="카드 삭제"
                          onClick={(e) => void handleDeleteCashFlowCard(latestCard, e)}
                        >
                          <DeleteIcon />
                        </button>
                      </div>
                      <div className="cashflow-summary-stats">
                        <div className="cashflow-stat">
                          <span className="cashflow-stat-label">수입</span>
                          <span className="cashflow-stat-value cashflow-stat-value--income">{formatAmount(income)}</span>
                        </div>
                        <div className="cashflow-stat">
                          <span className="cashflow-stat-label">지출</span>
                          <span className="cashflow-stat-value cashflow-stat-value--expense">{formatAmount(expense)}</span>
                        </div>
                        <div className="cashflow-stat">
                          <span className="cashflow-stat-label">잔액</span>
                          <span
                            className={`cashflow-stat-value ${
                              balance >= 0 ? 'cashflow-stat-value--balance' : 'cashflow-stat-value--negative'
                            }`}
                          >
                            {formatAmount(balance)}
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </div>
            ) : null}

            {/* 2) Latest card detail preview */}
            {latestCard && latestSubCards.length > 0 ? (
              <section className="latest-preview">
                <div className="sub-card-list">
                  {latestSubCards.map((subCard) => (
                    <SubCardComponent
                      key={subCard.id}
                      subCard={subCard}
                      readOnly
                      onDelete={() => {}}
                      onUpdateRows={() => {}}
                      onMoveUp={() => {}}
                      onMoveDown={() => {}}
                      askConfirm={async () => false}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* 3) Previous cards list */}
            {previousCardsRecentFirst.length > 0 ? <hr className="thick-divider" /> : null}
            {previousCardsRecentFirst.length > 0 ? (
              <div className="cashflow-card-list">
                {previousCardsRecentFirst.map((card) => {
                  const subCards = subCardsByCardId[card.id] ?? []
                  const { income, expense, balance } = calcSummary(subCards)
                  return (
                    <div
                      key={card.id}
                      className="cashflow-summary-card"
                      onClick={() => navigateToDetail(card.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') navigateToDetail(card.id)
                      }}
                    >
                      <div className="cashflow-card-header">
                        <p className="cashflow-card-name">{card.name}</p>
                        <button
                          type="button"
                          className="cashflow-card-delete-btn"
                          aria-label="카드 삭제"
                          onClick={(e) => void handleDeleteCashFlowCard(card, e)}
                        >
                          <DeleteIcon />
                        </button>
                      </div>
                      <div className="cashflow-summary-stats">
                        <div className="cashflow-stat">
                          <span className="cashflow-stat-label">수입</span>
                          <span className="cashflow-stat-value cashflow-stat-value--income">{formatAmount(income)}</span>
                        </div>
                        <div className="cashflow-stat">
                          <span className="cashflow-stat-label">지출</span>
                          <span className="cashflow-stat-value cashflow-stat-value--expense">{formatAmount(expense)}</span>
                        </div>
                        <div className="cashflow-stat">
                          <span className="cashflow-stat-label">잔액</span>
                          <span
                            className={`cashflow-stat-value ${
                              balance >= 0 ? 'cashflow-stat-value--balance' : 'cashflow-stat-value--negative'
                            }`}
                          >
                            {formatAmount(balance)}
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </>
        )}
      </main>

      <button
        type="button"
        className="fab"
        aria-label="새 카드 추가"
        onClick={() => {
          setCreateCashFlowError('')
          setShowCreateCashFlowModal(true)
        }}
      >
        <PlusIcon />
      </button>

      {showCreateCashFlowModal ? (
        <div className="modal-overlay" onClick={() => setShowCreateCashFlowModal(false)}>
          <form
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateCashFlowCard}
          >
            <h2 className="modal-title">새 카드 만들기</h2>
            <label className="field">
              <span>카드 이름</span>
              <input
                type="text"
                value={newCashFlowName}
                onChange={(e) => setNewCashFlowName(e.target.value)}
                autoFocus
              />
            </label>
            {createCashFlowError ? <p className="error-text">{createCashFlowError}</p> : null}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setShowCreateCashFlowModal(false)}>
                취소
              </button>
              <button type="submit" className="primary-button" disabled={!newCashFlowName.trim() || isCreatingCashFlow}>
                만들기
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        cancelLabel={confirmState.cancelLabel}
        onCancel={() => {
          setConfirmState((prev) => ({ ...prev, open: false }))
          confirmResolverRef.current?.(false)
          confirmResolverRef.current = null
        }}
        onConfirm={() => {
          setConfirmState((prev) => ({ ...prev, open: false }))
          confirmResolverRef.current?.(true)
          confirmResolverRef.current = null
        }}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// SubCardComponent
// ────────────────────────────────────────────────────────────
interface SubCardProps {
  subCard: SubCard
  onDelete: () => void
  onUpdateRows: (updater: (prev: Row[]) => Row[]) => void
  onMoveUp: () => void
  onMoveDown: () => void
  readOnly?: boolean
  askConfirm: (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string }) => Promise<boolean>
}

function SubCardComponent({ subCard, onDelete, onUpdateRows, onMoveUp, onMoveDown, readOnly = false, askConfirm }: SubCardProps) {
  const rows = subCard.rows ?? []
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(() => new Set())
  const [memoState, setMemoState] = useState<{ open: boolean; rowId: string | null; draft: string }>({
    open: false,
    rowId: null,
    draft: '',
  })

  const clearSelection = useCallback(() => setSelectedRowIds(new Set()), [])

  const total = useMemo(
    () => rows.reduce((acc, r) => acc + (r.excluded ? 0 : (Number(r.amount) || 0)), 0),
    [rows],
  )

  useEffect(() => {
    setSelectedRowIds((prev) => {
      if (prev.size === 0) return prev
      const existing = new Set(rows.map((r) => r.id))
      const next = new Set(Array.from(prev).filter((id) => existing.has(id)))
      return next
    })
  }, [rows])

  function upsertRow(id: string, patch: Partial<Row>) {
    onUpdateRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function addRows(count: number) {
    onUpdateRows((prev) => [
      ...prev,
      ...Array.from({ length: count }, (_, i) => ({
        ...makeEmptyRow(),
        sort_order: prev.length + i,
      })),
    ])
  }

  function toggleRowSelected(rowId: string, checked: boolean) {
    setSelectedRowIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(rowId)
      else next.delete(rowId)
      return next
    })
  }

  function getFirstSelectedRow() {
    for (const r of rows) {
      if (selectedRowIds.has(r.id)) return r
    }
    return null
  }

  function openMemoForSelected() {
    const row = getFirstSelectedRow()
    if (!row) return
    setMemoState({ open: true, rowId: row.id, draft: row.memo ?? '' })
  }

  function closeMemo() {
    setMemoState({ open: false, rowId: null, draft: '' })
  }

  async function saveMemo() {
    if (!memoState.rowId) return
    upsertRow(memoState.rowId, { memo: memoState.draft })
    closeMemo()
    clearSelection()
  }

  async function deleteMemoInDialog() {
    if (!memoState.rowId) return
    const ok = await askConfirm('메모를 삭제할까요?')
    if (!ok) return
    upsertRow(memoState.rowId, { memo: '' })
    closeMemo()
    clearSelection()
  }

  function getSelectedIndices() {
    const indices: number[] = []
    for (let i = 0; i < rows.length; i++) {
      if (selectedRowIds.has(rows[i].id)) indices.push(i)
    }
    return indices
  }

  function moveSelectedUp() {
    const indices = getSelectedIndices()
    if (indices.length === 0) return
    onUpdateRows((prev) => {
      const set = new Set(selectedRowIds)
      const next = [...prev]
      for (const idx of indices) {
        if (idx <= 0) continue
        if (!set.has(next[idx].id)) continue
        const tmp = next[idx - 1]
        next[idx - 1] = next[idx]
        next[idx] = tmp
      }
      return next.map((r, i) => ({ ...r, sort_order: i }))
    })
    clearSelection()
  }

  function moveSelectedDown() {
    const indices = getSelectedIndices()
    if (indices.length === 0) return
    onUpdateRows((prev) => {
      const set = new Set(selectedRowIds)
      const next = [...prev]
      for (let k = indices.length - 1; k >= 0; k--) {
        const idx = indices[k]
        if (idx >= next.length - 1) continue
        if (!set.has(next[idx].id)) continue
        const tmp = next[idx + 1]
        next[idx + 1] = next[idx]
        next[idx] = tmp
      }
      return next.map((r, i) => ({ ...r, sort_order: i }))
    })
    clearSelection()
  }

  function toggleLockSelected() {
    const ids = new Set(selectedRowIds)
    if (ids.size === 0) return
    onUpdateRows((prev) => {
      const selected = prev.filter((r) => ids.has(r.id))
      const allLocked = selected.length > 0 && selected.every((r) => Boolean(r.locked))
      const nextValue = !allLocked
      return prev.map((r) => (ids.has(r.id) ? { ...r, locked: nextValue } : r))
    })
    clearSelection()
  }

  function toggleBoxedSelected() {
    const ids = new Set(selectedRowIds)
    if (ids.size === 0) return
    onUpdateRows((prev) => {
      const selected = prev.filter((r) => ids.has(r.id))
      const allBoxed = selected.length > 0 && selected.every((r) => Boolean(r.boxed))
      const nextValue = !allBoxed
      return prev.map((r) => (ids.has(r.id) ? { ...r, boxed: nextValue } : r))
    })
    clearSelection()
  }

  async function deleteSelected() {
    const ids = new Set(selectedRowIds)
    if (ids.size === 0) return
    const ok = await askConfirm('삭제하시겠습니까?')
    if (!ok) return
    onUpdateRows((prev) => prev.filter((r) => !ids.has(r.id)).map((r, i) => ({ ...r, sort_order: i })))
    clearSelection()
  }

  const columnStyle = useMemo(() => {
    let maxAmountLen = 0
    const hasBoxMarker = rows.some((r) => Boolean(r.boxed))
    for (const r of rows) {
      const formatted = Number(r.amount) ? Number(r.amount).toLocaleString() : ''
      maxAmountLen = Math.max(maxAmountLen, formatted.length)
    }
    const boxExtraPx = hasBoxMarker ? 6 : 0
    const amountPxRaw = Math.max(84, Math.min(180, 18 + maxAmountLen * 10 + boxExtraPx))
    const amountPx = Math.max(70, Math.round(amountPxRaw * 0.95 * 0.95))
    return { ['--col-amount' as string]: `${amountPx}px` } as React.CSSProperties
  }, [rows])

  const handleEnterMove = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    if (readOnly) return
    e.preventDefault()
    const rowEl = e.currentTarget.closest('[data-row]') as HTMLElement | null
    const nextRow = rowEl?.nextElementSibling as HTMLElement | null
    if (!nextRow) return
    const col = e.currentTarget.dataset.col
    const next = nextRow.querySelector<HTMLInputElement>(`input[data-col="${col}"]`)
    next?.focus()
    next?.select?.()
  }

  return (
    <div
      className="sub-card"
      onPointerUp={(e) => {
        if (readOnly) return
        if (selectedRowIds.size === 0) return
        const target = e.target as HTMLElement
        if (target.closest('input,button,label,textarea')) return
        clearSelection()
      }}
    >
      <div className="excel-wrap" style={columnStyle}>
        {/* Header row */}
        <div className="excel-header excel-row">
          <div className="excel-cell cell-check">
            {readOnly ? null : (
              <button
                type="button"
                className="card-delete-btn card-delete-btn--header"
                aria-label="카드 삭제"
                onClick={onDelete}
              >
                <DeleteIcon />
              </button>
            )}
          </div>
          <div className="excel-cell cell-label">
            <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 8 }}>
              <strong className="card-title-cell" style={{ flex: 1, minWidth: 0 }}>
                &lt;{subCard.name}&gt;
              </strong>
              {readOnly ? null : (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                  <button type="button" className="icon-chip icon-chip--sm" aria-label="카드 위로" title="카드 위로" onClick={onMoveUp}>
                    <UpIcon />
                  </button>
                  <button type="button" className="icon-chip icon-chip--sm" aria-label="카드 아래로" title="카드 아래로" onClick={onMoveDown}>
                    <DownIcon />
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="excel-cell cell-amount header-total">
            {total ? total.toLocaleString() : ''}
          </div>
          <div className="excel-cell cell-lock" />
        </div>

        {/* Data rows */}
        {rows.map((row) => {
          const amt = Number(row.amount) || 0
          const amtDisplay = amt ? amt.toLocaleString() : ''

          return (
            <div
              key={row.id}
              data-row
              className={`excel-row${row.excluded ? ' excel-row--excluded' : ''}`}
            >
              <div className="excel-cell cell-check">
                <div className="row-check">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={selectedRowIds.has(row.id)}
                    onChange={(e) => toggleRowSelected(row.id, e.target.checked)}
                    aria-label="행 선택"
                  />
                </div>
              </div>
              <div className="excel-cell cell-label">
                <div className="cell-label-inner">
                  <input
                    type="text"
                    disabled={readOnly}
                    value={row.label}
                    onChange={(e) => upsertRow(row.id, { label: e.target.value })}
                    data-col="label"
                    onKeyDown={handleEnterMove}
                    className="excel-input"
                  />
                  {(row.memo ?? '').trim() ? (
                    <span className="row-memo-hover">
                      <button type="button" className="row-memo-btn" aria-label="메모 보기">
                        <PencilIcon />
                      </button>
                      <span className="row-memo-popover" role="tooltip">{row.memo}</span>
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="excel-cell cell-amount">
                <div className="amount-cell-inner">
                  {row.boxed && !readOnly ? (
                    <span className="row-box" aria-label="표시됨" title="표시됨">
                      □
                    </span>
                  ) : null}
                  <input
                    type="text"
                    inputMode="numeric"
                    disabled={readOnly}
                    value={amtDisplay}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/,/g, '')
                      const cleaned = raw.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '')
                      upsertRow(row.id, { amount: cleaned === '' || cleaned === '-' ? 0 : Number(cleaned) })
                    }}
                    data-col="amount"
                    onKeyDown={handleEnterMove}
                    className="excel-input text-right"
                  />
                </div>
              </div>
              <div className="excel-cell cell-lock">
                {row.locked ? (
                  <span className="row-lock" aria-label="잠금됨" title="잠금됨">
                    <LockSmallIcon />
                  </span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      {/* Card footer */}
      {readOnly ? null : (
        <div className="card-footer">
          <div className="row-bulk-actions">
            <button type="button" className="icon-chip" aria-label="한 줄 위로" title="한 줄 위로" onClick={moveSelectedUp}>
              <UpIcon />
            </button>
            <button type="button" className="icon-chip" aria-label="한 줄 아래로" title="한 줄 아래로" onClick={moveSelectedDown}>
              <DownIcon />
            </button>
            <button type="button" className="icon-chip icon-chip--lock" aria-label="잠금" title="잠금" onClick={toggleLockSelected}>
              <LockSmallIcon />
            </button>
            <button type="button" className="icon-chip" aria-label="메모" title="메모" onClick={openMemoForSelected}>
              <PencilIcon />
            </button>
            <button type="button" className="icon-chip" aria-label="표시" title="표시" onClick={toggleBoxedSelected}>
              <BoxIcon />
            </button>
            <button type="button" className="icon-chip icon-chip--danger" aria-label="선택 행 삭제" title="선택 행 삭제" onClick={() => void deleteSelected()}>
              <TrashIcon />
            </button>
          </div>

          <div className="add-row-actions">
            <button type="button" className="add-row-btn" onClick={() => addRows(1)}>
              <PlusIcon />1
            </button>
            <button type="button" className="add-row-btn" onClick={() => addRows(5)}>
              <PlusIcon />5
            </button>
          </div>
        </div>
      )}

      <MemoDialog
        open={readOnly ? false : memoState.open}
        value={memoState.draft}
        onChange={(next) => setMemoState((prev) => ({ ...prev, draft: next }))}
        onClose={closeMemo}
        onSave={() => void saveMemo()}
        onDelete={() => void deleteMemoInDialog()}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// Icons
// ────────────────────────────────────────────────────────────
function CashFlowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 6.5v11M9 9.5c0-1.1.9-2 3-2s3 .9 3 2-1 1.8-3 1.8-3 .8-3 1.8.9 2 3 2 3-.9 3-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.5 11V8.75a4.5 4.5 0 1 1 9 0V11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7.25 11h9.5a2 2 0 0 1 2 2v5.5a2.25 2.25 0 0 1-2.25 2.25h-9A2.25 2.25 0 0 1 5.25 18.5V13a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 15.3v2.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function LockSmallIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M8 11V8.5a4 4 0 0 1 8 0V11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="6" y="11" width="12" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 15v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 7.5h13M9.5 4.75h5l.75 2.75m-8 0 .55 9.2A2 2 0 0 0 9.8 18.6h4.4a2 2 0 0 0 1.99-1.9l.56-9.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 7.5h13M9.5 4.75h5l.75 2.75m-8 0 .55 9.2A2 2 0 0 0 9.8 18.6h4.4a2 2 0 0 0 1.99-1.9l.56-9.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  )
}

function UpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M12 5 6.5 10.5M12 5l5.5 5.5M12 5v14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M12 19 6.5 13.5M12 19l5.5-5.5M12 5v14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="m5.2 16.9 9.7-9.7a1.8 1.8 0 0 1 2.55 0l.6.6a1.8 1.8 0 0 1 0 2.55l-9.7 9.7-3.8.7.65-3.85Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function BoxIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.9" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default App
