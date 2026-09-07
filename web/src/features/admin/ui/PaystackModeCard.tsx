import { useState } from 'react'
import { Loader2, FlaskConical, Radio, AlertTriangle, Check, KeyRound } from 'lucide-react'
import { usePaystackMode, useSetPaystackMode, type PaystackMode } from '../data/adminSettingsApi'
import { apiErrorMessage } from '../../shared/libs/api'
import { formatDate } from '../../shared/libs/date'

/**
 * Test first, live second. The order is the point: the safe mode reads as the
 * default position and live is the deliberate step away from it, rather than
 * the two sitting side by side as equals.
 */
const MODES: {
  id: PaystackMode
  label: string
  blurb: string
  icon: typeof FlaskConical
  accent: string
}[] = [
  {
    id: 'test',
    label: 'Test',
    blurb: 'Charges run against Paystack test keys. No real money moves.',
    icon: FlaskConical,
    accent: 'text-slate-600 dark:text-slate-300',
  },
  {
    id: 'live',
    label: 'Live',
    blurb: 'Charges run against Paystack live keys. Real cards and real money.',
    icon: Radio,
    accent: 'text-rose-600 dark:text-rose-400',
  },
]

/**
 * Going live is the one switch here that costs real money if it is wrong, so it
 * asks. Going back to test does not — reverting to the safe mode should never be
 * the harder direction.
 */
function ConfirmLiveDialog({
  onCancel,
  onConfirm,
  pending,
}: {
  onCancel: () => void
  onConfirm: () => void
  pending: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-xl">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-rose-100 dark:bg-rose-950 p-2">
            <AlertTriangle size={18} className="text-rose-600 dark:text-rose-400" />
          </div>
          <div>
            <h4 className="font-display text-lg font-bold text-slate-900 dark:text-white">
              Switch to live mode?
            </h4>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 mt-1">
              Every deposit from this point charges a real card against your live Paystack account.
              Charges already in flight were started in test mode and will keep settling there.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-xl px-3.5 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-rose-700 cursor-pointer disabled:opacity-50"
          >
            {pending ? <Loader2 size={13} className="animate-spin" /> : <Radio size={13} />}
            Go live
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The Paystack test/live switch, as a settings panel.
 *
 * Admin-only — the endpoint behind it is `requireAdmin`, so this must not be
 * mounted for anyone else or the query 403s. Its caller decides that; the
 * component does not re-check.
 */
export function PaystackModeCard() {
  const { data, isLoading, error } = usePaystackMode()
  const setMode = useSetPaystackMode()
  const [confirmingLive, setConfirmingLive] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const apply = (mode: PaystackMode) => {
    setActionError(null)
    setMode.mutate(mode, {
      onSuccess: () => setConfirmingLive(false),
      onError: (err) => {
        setConfirmingLive(false)
        setActionError(apiErrorMessage(err))
      },
    })
  }

  const select = (mode: PaystackMode) => {
    if (mode === data?.mode) return
    if (mode === 'live') {
      setConfirmingLive(true)
      return
    }
    apply(mode)
  }

  return (
    <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-8 space-y-5 shadow-sm">
      <h3 className="font-display text-base font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-800 pb-3">
        Paystack Environment
      </h3>

      {isLoading && (
        <div className="flex justify-center py-6">
          <Loader2 className="animate-spin text-slate-400" />
        </div>
      )}

      {(error || actionError) && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-700 dark:bg-rose-950/60 dark:border-rose-800 dark:text-rose-300 flex items-center gap-2">
          <AlertTriangle size={14} />
          {actionError ?? apiErrorMessage(error)}
        </div>
      )}

      {data && (
        <>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Which set of keys every deposit is charged against. The change applies immediately, with
            no redeploy. Last changed {formatDate(data.updatedAt)}.
          </p>

          <div className="space-y-2">
            {MODES.map(({ id, label, blurb, icon: Icon, accent }) => {
              const active = data.mode === id
              const configured = id === 'live' ? data.liveKeyConfigured : data.testKeyConfigured
              const busy = setMode.isPending && setMode.variables === id

              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => select(id)}
                  disabled={!configured || setMode.isPending}
                  className={`w-full flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all cursor-pointer disabled:cursor-not-allowed ${
                    active
                      ? 'border-primary-500 bg-primary-50/60 dark:border-primary-600 dark:bg-primary-950/40 ring-1 ring-primary-500'
                      : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60'
                  } ${!configured ? 'opacity-60' : ''}`}
                >
                  <Icon size={16} className={`mt-0.5 shrink-0 ${accent}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-900 dark:text-white">{label}</span>
                      {active && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary-600 px-2 py-0.5 text-[10px] font-bold text-white">
                          <Check size={10} /> Current
                        </span>
                      )}
                      {busy && <Loader2 size={12} className="animate-spin text-slate-400" />}
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">{blurb}</p>
                    {!configured && (
                      <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                        <KeyRound size={11} />
                        No {id} secret key is set on the server, so this mode cannot be selected.
                      </p>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}

      {confirmingLive && (
        <ConfirmLiveDialog
          onCancel={() => setConfirmingLive(false)}
          onConfirm={() => apply('live')}
          pending={setMode.isPending}
        />
      )}
    </div>
  )
}
