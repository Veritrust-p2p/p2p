import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  ShieldCheck,
  User,
  Mail,
  Phone,
  Lock,
  Bell,
  ArrowLeft,
  CheckCircle2,
  Clock,
  XCircle,
  Save,
  Camera,
  Loader2,
  Trash2,
  Palette,
  SlidersHorizontal,
  Sun,
  Moon,
  Check,
} from 'lucide-react'
import { useMe } from '../features/auth/data/authApi'
import { useUpdateNotificationPrefs, useUpdateProfile } from '../features/user/data/usersApi'
import { useUploadSingleFile } from '../features/upload/data/uploadApi'
import { profileSchema, type ProfileForm } from '../features/user/data/schemas'
import { apiErrorMessage } from '../features/shared/libs/api'

// Shared with the header's toggle. Kept in one module so the two controls
// cannot disagree about what "dark" means or where it is stored — and so
// changing it here updates the header icon, via the event that module fires.
import { applyTheme } from '../features/shared/libs/theme'
import { PaystackModeCard } from '../features/admin/ui/PaystackModeCard'

const inputClass =
  'w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 py-2.5 pl-10 pr-4 text-xs sm:text-sm text-slate-900 dark:text-white focus:border-primary-500 focus:outline-none'

const lockedInputClass =
  'w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 py-2.5 pl-10 pr-4 text-xs sm:text-sm text-slate-500 dark:text-slate-400 cursor-not-allowed'

/**
 * A miniature of the app in one theme, so the choice is legible before it's
 * made. Fixed colours on purpose — no `dark:` variants — otherwise the light
 * swatch would render dark while you're in dark mode and preview nothing.
 */
function ThemePreview({ dark }: { dark: boolean }) {
  return (
    <span
      className={`block rounded-xl border p-3 ${
        dark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'
      }`}
    >
      <span className="mb-2.5 flex items-center gap-1.5">
        <span className={`h-4 w-4 rounded-md ${dark ? 'bg-primary-500' : 'bg-primary-600'}`} />
        <span className={`h-1.5 w-10 rounded-full ${dark ? 'bg-slate-600' : 'bg-slate-300'}`} />
      </span>
      <span className="block space-y-1.5">
        <span className={`block h-1.5 w-full rounded-full ${dark ? 'bg-slate-700' : 'bg-slate-200'}`} />
        <span className={`block h-1.5 w-4/5 rounded-full ${dark ? 'bg-slate-700' : 'bg-slate-200'}`} />
        <span className={`block h-1.5 w-2/3 rounded-full ${dark ? 'bg-slate-800' : 'bg-slate-100'}`} />
      </span>
    </span>
  )
}

const THEME_OPTIONS = [
  { dark: false, label: 'Light', icon: Sun, hint: 'Bright surfaces with dark text. Best in daylight.' },
  { dark: true, label: 'Dark', icon: Moon, hint: 'Dimmed surfaces, easier on the eyes at night.' },
] as const

export function UserSettings() {
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'notifications' | 'appearance' | 'platform'>('profile')
  const [isDarkTheme, setIsDarkTheme] = useState(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : false,
  )

  const { data: me } = useMe()
  const updateProfile = useUpdateProfile()
  const updatePrefs = useUpdateNotificationPrefs()
  const uploadAvatar = useUploadSingleFile()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    // Prefill from the signed-in user as soon as /me resolves (and stay in sync after saves)
    values: me ? { fullName: me.fullName, phone: me.phone ?? '' } : undefined,
  })

  // Auto-hide the success banner
  useEffect(() => {
    if (updateProfile.isSuccess) {
      const timer = setTimeout(() => updateProfile.reset(), 3000)
      return () => clearTimeout(timer)
    }
  }, [updateProfile.isSuccess, updateProfile])

  const onSaveProfile = handleSubmit((values) => {
    updateProfile.mutate({
      fullName: values.fullName,
      phone: values.phone === '' ? null : values.phone,
    })
  })

  // Upload the picked image to Cloudinary, then persist its URL on the profile.
  const onAvatarSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked later
    if (!file) return
    uploadAvatar.mutate(file, {
      onSuccess: (res) => updateProfile.mutate({ avatarUrl: res.url }),
    })
  }

  const removeAvatar = () => updateProfile.mutate({ avatarUrl: null })
  const avatarBusy = uploadAvatar.isPending || updateProfile.isPending

  const selectTheme = (dark: boolean) => {
    applyTheme(dark)
    setIsDarkTheme(dark)
  }

  useEffect(() => {
    setIsDarkTheme(document.documentElement.classList.contains('dark'))
  }, [])

  const kycStatus = me?.kycStatus ?? 'unverified'

  return (
    <div className="py-4 sm:py-6 space-y-6">
      {/* Back link */}
      <Link
        to="/dashboard"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
      >
        <ArrowLeft size={16} />
        Back to Dashboard
      </Link>

      <div className="border-b border-slate-200 dark:border-slate-800 pb-4 sm:pb-5">
        <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
          Account Settings & Security
        </h1>
        <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300">
          Manage your personal details, KYC identity verification, and escrow notification preferences.
        </p>
      </div>

      {updateProfile.isSuccess && (
        <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/80 border border-emerald-200 dark:border-emerald-800 p-3.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-2 animate-fade-in">
          <CheckCircle2 size={16} className="text-emerald-600 dark:text-emerald-400" />
          Your account settings have been saved successfully!
        </div>
      )}

      {updateProfile.isError && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 p-3.5 text-xs font-semibold text-rose-700 dark:bg-rose-950/60 dark:border-rose-800 dark:text-rose-300 animate-fade-in">
          {apiErrorMessage(updateProfile.error)}
        </div>
      )}

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-8">
        {/* Left Sidebar Menu */}
        <div className="lg:col-span-4 space-y-4">
          <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5 sm:p-4 shadow-sm space-y-1 text-xs font-semibold">
            {[
              { id: 'profile', label: 'Personal Information', icon: User },
              { id: 'security', label: 'Security & Password', icon: Lock },
              { id: 'notifications', label: 'Escrow Notifications', icon: Bell },
              { id: 'appearance', label: 'Appearance', icon: Palette },
              // Admin-only, and rendered nowhere else: the endpoint behind this
              // tab is requireAdmin, so it must not mount for a normal user.
              ...(me?.role === 'admin'
                ? [{ id: 'platform', label: 'Platform', icon: SlidersHorizontal }]
                : []),
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id as typeof activeTab)}
                className={`w-full flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 transition-all text-left cursor-pointer ${
                  activeTab === id
                    ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold shadow-sm'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>

          {/* KYC Status Card — live from /me */}
         {me?.role == "user" && !me.kycStatus && <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-4 sm:p-5 space-y-3">
            <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white text-xs">
              <ShieldCheck size={16} className="text-emerald-600 dark:text-emerald-400" />
              KYC Verification Status
            </div>
            <div className="flex items-center gap-2">
              {kycStatus === 'verified' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-950 px-3 py-1 text-xs font-bold text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  <CheckCircle2 size={13} /> Verified Seller
                </span>
              )}
              {kycStatus === 'pending' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-950 px-3 py-1 text-xs font-bold text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                  <Clock size={13} /> Under Review
                </span>
              )}
              {kycStatus === 'rejected' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 dark:bg-rose-950 px-3 py-1 text-xs font-bold text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                  <XCircle size={13} /> Rejected
                </span>
              )}
              {kycStatus === 'unverified' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 dark:bg-slate-800 px-3 py-1 text-xs font-bold text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700">
                  Not Verified
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              {kycStatus === 'verified' &&
                'Your identity is verified. You can create marketplace listings and receive payouts.'}
              {kycStatus === 'pending' &&
                'Your KYC submission is with our review team. You can buy and use escrow deals while you wait.'}
              {kycStatus === 'rejected' &&
                'Your submission was rejected. Review the reason and resubmit from the seller verification page.'}
              {kycStatus === 'unverified' &&
                'Verify your identity to unlock marketplace selling. Buying and standalone escrow deals need no KYC.'}
            </p>
            {kycStatus !== 'verified' && kycStatus !== 'pending' && (
              <Link
                to="/sell"
                className="inline-flex items-center gap-1.5 text-[11px] font-bold text-primary-600 dark:text-primary-400 hover:underline"
              >
                Start seller verification →
              </Link>
            )}
          </div>}
        </div>

        {/* Right Content Area */}
        <div className="lg:col-span-8">
          {activeTab === 'profile' && (
            <form onSubmit={onSaveProfile} className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-8 space-y-5 shadow-sm" noValidate>
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-800 pb-3">
                Personal Information
              </h3>

              {/* Profile photo */}
              <div className="flex items-center gap-4">
                <div className="relative shrink-0">
                  {me?.avatarUrl ? (
                    <img
                      src={me.avatarUrl}
                      alt="Your profile photo"
                      className="h-20 w-20 rounded-2xl object-cover border border-slate-200 dark:border-slate-700"
                    />
                  ) : (
                    <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary-600 text-2xl font-bold text-white uppercase">
                      {me?.username.charAt(0) ?? '?'}
                    </span>
                  )}
                  {avatarBusy && (
                    <span className="absolute inset-0 flex items-center justify-center rounded-2xl bg-slate-950/50">
                      <Loader2 size={20} className="animate-spin text-white" />
                    </span>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={avatarBusy || !me}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                    >
                      <Camera size={14} /> {me?.avatarUrl ? 'Change photo' : 'Upload photo'}
                    </button>
                    {me?.avatarUrl && (
                      <button
                        type="button"
                        onClick={removeAvatar}
                        disabled={avatarBusy}
                        className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer disabled:opacity-50"
                      >
                        <Trash2 size={14} /> Remove
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500">
                    JPG or PNG, up to 10MB. Shown on your profile, listings, and deals.
                  </p>
                  {uploadAvatar.isError && (
                    <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                      {apiErrorMessage(uploadAvatar.error)}
                    </p>
                  )}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={onAvatarSelected}
                  className="hidden"
                />
              </div>

              {/* Full Name */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400" htmlFor="user-fullname">
                  Full Name
                </label>
                <div className="relative">
                  <User size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input id="user-fullname" type="text" {...register('fullName')} className={inputClass} />
                </div>
                {errors.fullName && (
                  <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">{errors.fullName.message}</p>
                )}
              </div>

              {/* Username — immutable */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400" htmlFor="user-username">
                  Username
                </label>
                <div className="relative">
                  <User size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input id="user-username" type="text" value={me?.username ?? ''} readOnly disabled className={lockedInputClass} />
                </div>
                <p className="text-[11px] text-slate-400 dark:text-slate-500">
                  Usernames are permanent — they identify you on deals and listings.
                </p>
              </div>

              {/* Email — immutable */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400" htmlFor="user-email">
                  Email Address
                </label>
                <div className="relative">
                  <Mail size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input id="user-email" type="email" value={me?.email ?? ''} readOnly disabled className={lockedInputClass} />
                </div>
                <p className="text-[11px] text-slate-400 dark:text-slate-500">
                  Contact support to change the email on your account.
                </p>
              </div>

              {/* Phone */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400" htmlFor="user-phone">
                  Phone Number
                </label>
                <div className="relative">
                  <Phone size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input id="user-phone" type="text" {...register('phone')} placeholder="+233 24 000 0000" className={inputClass} />
                </div>
                {errors.phone && (
                  <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">{errors.phone.message}</p>
                )}
              </div>

              <button
                type="submit"
                disabled={updateProfile.isPending || !me}
                className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-primary-700 transition-all cursor-pointer shadow-md disabled:opacity-50"
              >
                <Save size={15} /> {updateProfile.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            </form>
          )}

          {activeTab === 'security' && (
            <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-8 space-y-5 shadow-sm">
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-800 pb-3">
                Security & Password Management
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                To update your account password, click below to launch the secure password change flow.
              </p>
              <Link
                to="/change-password"
                className="inline-flex items-center gap-2 rounded-xl bg-slate-900 dark:bg-white px-5 py-2.5 text-xs font-semibold text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-100 transition-all"
              >
                <Lock size={15} /> Change Account Password
              </Link>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-8 space-y-5 shadow-sm">
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-800 pb-3">
                Escrow Notification Preferences
              </h3>
              <div className="space-y-3 text-xs">
                <label className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 cursor-pointer text-slate-800 dark:text-slate-200">
                  <span>Receive Email on order shipment & tracking update</span>
                  <input
                    type="checkbox"
                    checked={me?.prefs.emailShipmentUpdates ?? true}
                    disabled={!me || updatePrefs.isPending}
                    onChange={(e) =>
                      updatePrefs.mutate({
                        emailShipmentUpdates: e.target.checked,
                        smsReleaseAlerts: me?.prefs.smsReleaseAlerts ?? false,
                      })
                    }
                    className="rounded text-primary-600"
                  />
                </label>
                <label className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 cursor-pointer text-slate-800 dark:text-slate-200">
                  <span>SMS alert when funds are ready for release</span>
                  <input
                    type="checkbox"
                    checked={me?.prefs.smsReleaseAlerts ?? false}
                    disabled={!me || updatePrefs.isPending}
                    onChange={(e) =>
                      updatePrefs.mutate({
                        emailShipmentUpdates: me?.prefs.emailShipmentUpdates ?? true,
                        smsReleaseAlerts: e.target.checked,
                      })
                    }
                    className="rounded text-primary-600"
                  />
                </label>
                {updatePrefs.isError && (
                  <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                    {apiErrorMessage(updatePrefs.error)}
                  </p>
                )}
                <p className="text-[11px] text-slate-400 dark:text-slate-500">
                  Preferences save automatically when toggled.
                </p>
              </div>
            </div>
          )}
          {activeTab === 'appearance' && (
            <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-8 space-y-5 shadow-sm">
              <h3 className="font-display text-base font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-800 pb-3">
                Appearance
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                Choose how the app looks. The change applies immediately, everywhere.
              </p>

              <div
                role="radiogroup"
                aria-label="Theme"
                className="grid grid-cols-1 sm:grid-cols-2 gap-4"
              >
                {THEME_OPTIONS.map(({ dark, label, icon: Icon, hint }) => {
                  const isSelected = isDarkTheme === dark
                  return (
                    <button
                      key={label}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => selectTheme(dark)}
                      className={`rounded-2xl border p-4 text-left space-y-3 transition-all cursor-pointer ${
                        isSelected
                          ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-950/40 shadow-md ring-1 ring-primary-500'
                          : 'border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 hover:-translate-y-0.5 hover:border-primary-400 hover:shadow-md dark:hover:border-primary-700'
                      }`}
                    >
                      <ThemePreview dark={dark} />

                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                          <Icon size={14} className={dark ? 'text-indigo-500' : 'text-amber-500'} />
                          {label}
                        </span>
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                            isSelected
                              ? 'border-primary-600 bg-primary-600 text-white'
                              : 'border-slate-300 dark:border-slate-700'
                          }`}
                        >
                          {isSelected && <Check size={10} />}
                        </span>
                      </div>

                      <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{hint}</p>
                    </button>
                  )
                })}
              </div>

              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                Stored in this browser, so it follows you across every page here — but not to your other devices.
              </p>
            </div>
          )}

          {/* The role check is repeated here rather than trusted from the tab
              list: activeTab is state, and this panel must not render for a
              non-admin even if it somehow gets set. */}
          {activeTab === 'platform' && me?.role === 'admin' && <PaystackModeCard />}
        </div>
      </div>
    </div>
  )
}
