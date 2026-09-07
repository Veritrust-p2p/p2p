import { useState } from 'react';
import { Image } from 'expo-image';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Pressable } from '@/components/ui/pressable';
import { useRouter } from 'expo-router';
import {
  AlertTriangle,
  CheckCircle2,
  Heart,
  Lock,
  Package,
  Plus,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Truck,
} from '@/components/icons';

import { Fonts, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useSaved } from '@/context/SavedContext';
import { type User } from '@/constants/appTypes';
import { apiErrorMessage } from '@/features/shared/data/api';
import { useDashboard, type DashboardOrder } from '../data/dashboardApi';
import { useReleaseDeal } from '@/features/escrow/data/dealsApi';
import { AppBar } from '@/features/shared/ui/AppBar';
import { ConfirmDialog } from '@/features/shared/ui/ConfirmDialog';
import { formatMoney } from '@/features/shared/libs/currency';
import { StatCard } from './StatCard';

/**
 * Buyer home — the phone version of `web/src/pages/UserDashboard.tsx`.
 *
 * Same sections in the same order: profile hero, four metric tiles, the
 * standalone-escrow banner, then recent marketplace orders with the
 * confirm-receipt action.
 *
 * Reads `/api/users/me/dashboard`, the same endpoint the web's dashboard uses,
 * so the two never disagree about a figure.
 */

const money = (amount: number, currency: 'GHS' | 'TRX' = 'GHS') =>
  currency === 'TRX'
    ? `${amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} TRX`
    : `GH₵${amount.toLocaleString('en-GH', { maximumFractionDigits: 2 })}`;

/**
 * Maps the raw escrow status onto the web's badge tones.
 *
 * The buyer block of the dashboard sends the status unmapped — unlike the
 * seller block, which pre-translates it — so the lifecycle words are handled
 * here rather than the UI words the mock used to carry.
 */
function statusBadge(status: string) {
  switch (status) {
    case 'disbursed':
      return { label: 'COMPLETED', bg: '#dcfce7', text: '#166534' };
    case 'delivered':
      return { label: 'DELIVERED', bg: '#dbeafe', text: '#1e40af' };
    case 'disputed':
      return { label: 'DISPUTED', bg: '#fee2e2', text: '#991b1b' };
    case 'cancelled':
      return { label: 'CANCELLED', bg: '#f3f4f6', text: '#374151' };
    case 'created':
      return { label: 'AWAITING PAYMENT', bg: '#fef9c3', text: '#854d0e' };
    default:
      return { label: 'IN ESCROW', bg: '#fef9c3', text: '#854d0e' };
  }
}

export function BuyerDashboard({ user }: { user: User }) {
  const theme = useTheme();
  const router = useRouter();
  const { count: savedCount } = useSaved();

  const dashboard = useDashboard();
  const release = useReleaseDeal();
  /** Which order's release is in flight — so only that row shows a spinner. */
  const [releasingId, setReleasingId] = useState<string | null>(null);
  /** The order awaiting its release confirmation. */
  const [pendingRelease, setPendingRelease] = useState<DashboardOrder | null>(null);

  const stats = dashboard.data?.buyer.stats;
  const orders = dashboard.data?.buyer.recentOrders ?? [];

  /**
   * The release itself. Reached only from the confirmation dialog — this card
   * used to release the escrow on a single tap, with no way back.
   */
  const confirmReceipt = (orderId: string) => {
    if (release.isPending) return;
    setReleasingId(orderId);
    release.mutate(orderId, {
      onSettled: () => {
        setReleasingId(null);
        setPendingRelease(null);
      },
    });
  };

  /*
    Same split as the deal screen: with the seller's delivery on record this
    confirms a claim already made, without it the buyer is asserting receipt
    themselves. `status` is the raw escrow status here, so 'delivered' versus
    'funded' is exactly that distinction.
  */
  const releaseDelivered = pendingRelease?.status === 'delivered';
  /** Net of fees, matching the deal screen — not the gross escrow amount. */
  const releaseAmount = pendingRelease
    ? formatMoney(pendingRelease.sellerPayout, pendingRelease.currency)
    : '';

  const joined = new Date(user.createdAt).toLocaleDateString('en-GB', {
    month: 'short',
    year: 'numeric',
  });

  return (
    <View style={styles.wrap}>
      {/* Wallet, messages and notifications — the same bar the seller home
          wears, so the two personas don't diverge. The wallet is asked for
          here: the bar is shared with the admin console, which has none. */}
      <AppBar showWallet />

      {/* Profile hero */}
      <View style={[styles.hero, { backgroundColor: theme.card, borderColor: theme.cardBorder }]}>
        <View style={styles.heroTop}>
          <View>
            {user.avatarUrl ? (
              <Image source={user.avatarUrl} style={styles.avatar} contentFit="cover" />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: theme.primary }]}>
                <Text style={styles.avatarLetter}>{user.fullName.charAt(0)}</Text>
              </View>
            )}
            {user.kycStatus === 'verified' ? (
              <View style={[styles.verifiedDot, { borderColor: theme.card }]}>
                <ShieldCheck size={12} color="#ffffff" />
              </View>
            ) : null}
          </View>

          <View style={styles.heroText}>
            <Text style={[styles.heroName, { color: theme.text }]} numberOfLines={1}>
              {user.fullName}
            </Text>
            <Text style={[styles.heroHandle, { color: theme.textSecondary }]} numberOfLines={1}>
              @{user.username}
            </Text>
            <Text style={[styles.heroMeta, { color: theme.textTertiary }]} numberOfLines={1}>
              Member since {joined} ·{' '}
              <Text style={{ color: theme.primary, fontFamily: Fonts.sans[700] }}>
                Protected Buyer
              </Text>
            </Text>
          </View>
        </View>

        <View style={styles.heroActions}>
          <Pressable
            onPress={() => router.push('/deals')}
            style={({ pressed }) => [
              styles.heroBtn,
              {
                backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
                borderColor: theme.border,
              },
            ]}
          >
            <Text style={[styles.heroBtnText, { color: theme.text }]}>My Orders</Text>
          </Pressable>
          <Pressable
            // The Profile tab holds the real account UI (the web's
            // UserSettings); /settings is still a placeholder route.
            onPress={() => router.push('/profile')}
            style={({ pressed }) => [
              styles.heroBtn,
              styles.heroBtnDark,
              { backgroundColor: theme.text, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Settings size={14} color={theme.background} />
            <Text style={[styles.heroBtnText, { color: theme.background }]}>Profile Settings</Text>
          </Pressable>
        </View>
      </View>

      {/* Metrics — "—" until the figures land, never a confident zero. */}
      <View style={styles.grid}>
        <StatCard
          label="Active Orders"
          value={stats ? String(stats.activeOrdersCount) : '—'}
          sub="In escrow or shipped"
          icon={ShoppingBag}
          onPress={() => router.push('/deals')}
        />
        <StatCard
          label="Escrow Locked"
          value={stats ? money(stats.escrowLockedBalance) : '—'}
          sub="100% Deposit Protection"
          icon={Lock}
          accent={theme.primary}
          subAccent={theme.primary}
        />
        <StatCard
          label="Total Purchases"
          value={stats ? money(stats.totalSpent) : '—'}
          sub="Across all marketplace deals"
          icon={Package}
          accent="#0284c7"
        />
        <StatCard
          label="Saved Items"
          /*
            SavedContext, not `stats.savedItemsCount`. The context updates the
            instant you tap the heart on a listing; the dashboard figure is a
            cached round trip behind, so preferring the server value would make
            the tile visibly lag the Bookmarks screen it links to.
          */
          value={String(savedCount)}
          sub="View my bookmarks →"
          icon={Heart}
          accent="#f43f5e"
          onPress={() => router.push('/bookmarks')}
        />
      </View>

      {/* Standalone escrow banner */}
      <View style={[styles.banner, { backgroundColor: theme.primaryLight }]}>
        <Text style={[styles.bannerTitle, { color: theme.text }]}>
          Have an off-market 3rd-party deal?
        </Text>
        <Text style={[styles.bannerBody, { color: theme.textSecondary }]}>
          Create an independent escrow deal for freelance work or domain sales.
        </Text>
        <Pressable
          onPress={() => router.push('/escrow/new')}
          style={({ pressed }) => [
            styles.bannerBtn,
            { backgroundColor: theme.primary, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Plus size={16} color="#ffffff" />
          <Text style={styles.bannerBtnText}>Start Escrow Deal</Text>
        </Pressable>
      </View>

      {/* Recent orders */}
      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent Marketplace Orders</Text>
        <Pressable onPress={() => router.push('/deals')} hitSlop={8}>
          <Text style={[styles.sectionLink, { color: theme.primary }]}>View All →</Text>
        </Pressable>
      </View>

      {dashboard.isLoading ? (
        <View style={styles.ordersLoading}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : dashboard.isError ? (
        <View style={[styles.apiError, { backgroundColor: '#fee2e2', borderColor: '#fecaca' }]}>
          <AlertTriangle size={15} color="#991b1b" />
          <Text style={styles.apiErrorText}>{apiErrorMessage(dashboard.error)}</Text>
        </View>
      ) : orders.length === 0 ? (
        <View style={[styles.empty, { backgroundColor: theme.card, borderColor: theme.cardBorder }]}>
          <ShoppingBag size={28} color={theme.textTertiary} />
          <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
            No active or recent orders found.
          </Text>
          <Pressable
            onPress={() => router.push('/marketplace')}
            style={({ pressed }) => [
              styles.bannerBtn,
              { backgroundColor: theme.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={styles.bannerBtnText}>Browse Marketplace</Text>
          </Pressable>
        </View>
      ) : (
        orders.map((order) => {
          const badge = statusBadge(order.status);
          /*
            Only these two. The server rejects a release from any other state,
            so offering the button on, say, a disputed or already-disbursed
            order would just produce an error the buyer can't act on.
          */
          const canRelease = order.status === 'funded' || order.status === 'delivered';
          const isReleasing = releasingId === order.id;

          return (
            <Pressable
              key={order.id}
              onPress={() => router.push(`/escrow/${order.id}`)}
              style={({ pressed }) => [
                styles.order,
                { backgroundColor: theme.card, borderColor: pressed ? theme.primary : theme.cardBorder },
              ]}
            >
              <View style={[styles.orderTop, { borderBottomColor: theme.border }]}>
                <View style={[styles.badge, { backgroundColor: badge.bg }]}>
                  <Text style={[styles.badgeText, { color: badge.text }]}>{badge.label}</Text>
                </View>
                <Text style={[styles.orderCode, { color: theme.textTertiary }]} numberOfLines={1}>
                  {order.code} · {order.orderDate}
                </Text>
                <Text style={[styles.orderVendor, { color: theme.textSecondary }]} numberOfLines={1}>
                  @{order.vendorName}
                </Text>
              </View>

              <View style={styles.orderBody}>
                <Image source={order.imageUrl} style={styles.orderImage} contentFit="cover" />
                <View style={styles.orderInfo}>
                  <Text style={[styles.orderTitle, { color: theme.text }]} numberOfLines={1}>
                    {order.title}
                  </Text>
                  <Text style={[styles.orderPrice, { color: theme.text }]}>
                    {money(order.price, order.currency)}
                  </Text>
                  {order.trackingCode ? (
                    <View style={styles.trackingRow}>
                      <Truck size={12} color={theme.primary} />
                      <Text style={[styles.tracking, { color: theme.textSecondary }]} numberOfLines={1}>
                        {order.shippingCarrier ? `${order.shippingCarrier}: ` : ''}
                        {order.trackingCode}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>

              {/* Action row — mirrors the web's status-dependent controls */}
              {order.status === 'disputed' ? (
                <View style={[styles.statusNote, { backgroundColor: '#fef3c7' }]}>
                  <AlertTriangle size={14} color="#92400e" />
                  <Text style={[styles.statusNoteText, { color: '#92400e' }]}>
                    Under Dispute Review
                  </Text>
                </View>
              ) : canRelease ? (
                <Pressable
                  onPress={(e) => {
                    // The whole card navigates to the deal; releasing must not
                    // also open it, or the confirmation is lost behind a push.
                    e.stopPropagation();
                    setPendingRelease(order);
                  }}
                  disabled={release.isPending}
                  accessibilityRole="button"
                  accessibilityLabel={`Confirm receipt and release escrow for ${order.title}`}
                  style={({ pressed }) => [
                    styles.releaseBtn,
                    { backgroundColor: theme.primary, opacity: release.isPending ? 0.6 : pressed ? 0.85 : 1 },
                  ]}
                >
                  {isReleasing ? (
                    <ActivityIndicator color="#ffffff" size="small" />
                  ) : (
                    <>
                      <CheckCircle2 size={16} color="#ffffff" />
                      <Text style={styles.releaseText}>Confirm Receipt &amp; Release Escrow</Text>
                    </>
                  )}
                </Pressable>
              ) : order.status === 'disbursed' ? (
                <View style={styles.statusNote}>
                  <CheckCircle2 size={15} color={theme.primary} />
                  <Text style={[styles.statusNoteText, { color: theme.primary }]}>
                    Completed &amp; Paid Out
                  </Text>
                </View>
              ) : order.status === 'created' ? (
                /*
                  Unfunded. This used to fall through to "Completed & Paid Out"
                  along with every other non-releasable state, which told a
                  buyer their unpaid order was settled. Funding lives on the
                  deal screen, which the card already opens.
                */
                <View style={[styles.statusNote, { backgroundColor: '#fef9c3' }]}>
                  <Lock size={14} color="#854d0e" />
                  <Text style={[styles.statusNoteText, { color: '#854d0e' }]}>
                    Awaiting payment — tap to fund
                  </Text>
                </View>
              ) : order.status === 'cancelled' ? (
                <View style={styles.statusNote}>
                  <AlertTriangle size={14} color={theme.textTertiary} />
                  <Text style={[styles.statusNoteText, { color: theme.textTertiary }]}>
                    Cancelled and refunded
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })
      )}

      <ConfirmDialog
        open={pendingRelease !== null}
        tone={releaseDelivered ? 'primary' : 'danger'}
        title={releaseDelivered ? 'Release the escrow?' : 'Release without a delivery update?'}
        description={
          releaseDelivered
            ? `${pendingRelease?.vendorName ?? 'The seller'} has marked this as delivered. Confirming says you received it.`
            : `${pendingRelease?.vendorName ?? 'The seller'} has not marked this as delivered. You are confirming, on your own, that the item reached you.`
        }
        consequence={
          releaseDelivered
            ? `${releaseAmount} is released to the seller. This cannot be undone.`
            : `${releaseAmount} is released to the seller even though delivery is still pending. Only continue if you actually have the item — this cannot be undone.`
        }
        confirmLabel="Release Funds"
        cancelLabel="Not yet"
        isPending={release.isPending}
        onCancel={() => setPendingRelease(null)}
        onConfirm={() => pendingRelease && confirmReceipt(pendingRelease.id)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  ordersLoading: { paddingVertical: Spacing.six, alignItems: 'center' },
  apiError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.three,
  },
  apiErrorText: { flex: 1, fontSize: 12.5, lineHeight: 18, fontFamily: Fonts.sans[500], color: '#991b1b' },

  wrap: { gap: Spacing.three },

  hero: { borderWidth: 1, borderRadius: Radius.lg, padding: Spacing.four, gap: Spacing.three },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  avatar: { height: 60, width: 60, borderRadius: Radius.md },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontSize: 19, fontFamily: Fonts.sans[700], color: '#ffffff' },
  verifiedDot: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    height: 22,
    width: 22,
    borderRadius: Radius.full,
    borderWidth: 2,
    backgroundColor: '#22c55e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: { flex: 1, gap: 2 },
  // Name uses the web's `font-display`.
  heroName: { fontSize: 17, fontFamily: Fonts.display[700], letterSpacing: -0.4 },
  heroHandle: { fontSize: 12, fontFamily: Fonts.sans[600] },
  heroMeta: { fontSize: 11, fontFamily: Fonts.sans[400] },

  heroActions: { flexDirection: 'row', gap: Spacing.two },
  heroBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 42,
    borderWidth: 1,
    borderRadius: Radius.md,
  },
  heroBtnDark: { borderColor: 'transparent' },
  heroBtnText: { fontSize: 12, fontFamily: Fonts.sans[700] },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },

  banner: { borderRadius: Radius.lg, padding: Spacing.four, gap: 6 },
  bannerTitle: { fontSize: 14, fontFamily: Fonts.display[700] },
  bannerBody: { fontSize: 12, lineHeight: 17, fontFamily: Fonts.sans[400] },
  bannerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    height: 44,
    borderRadius: Radius.md,
    marginTop: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
  bannerBtnText: { fontSize: 13, fontFamily: Fonts.sans[700], color: '#ffffff' },

  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.two,
  },
  sectionTitle: { fontSize: 15, fontFamily: Fonts.display[700], letterSpacing: -0.3 },
  sectionLink: { fontSize: 12, fontFamily: Fonts.sans[700] },

  empty: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Spacing.five,
    alignItems: 'center',
    gap: Spacing.two,
  },
  emptyText: { fontSize: 13, fontFamily: Fonts.sans[600], textAlign: 'center' },

  order: { borderWidth: 1, borderRadius: Radius.lg, padding: Spacing.three, gap: Spacing.three },
  orderTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    borderBottomWidth: 1,
    paddingBottom: Spacing.two,
  },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.sm },
  badgeText: { fontSize: 9.5, fontFamily: Fonts.sans[700], letterSpacing: 0.3 },
  orderCode: { flex: 1, fontSize: 10, fontFamily: Fonts.sans[500] },
  orderVendor: { fontSize: 11, fontFamily: Fonts.sans[600], flexShrink: 1 },

  orderBody: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  orderImage: { height: 56, width: 56, borderRadius: Radius.sm },
  orderInfo: { flex: 1, gap: 2 },
  orderTitle: { fontSize: 13, fontFamily: Fonts.sans[700] },
  orderPrice: { fontSize: 13, fontFamily: Fonts.display[700] },
  trackingRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  tracking: { flex: 1, fontSize: 10.5, fontFamily: Fonts.sans[500] },

  releaseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    height: 44,
    borderRadius: Radius.md,
  },
  releaseText: { fontSize: 12.5, fontFamily: Fonts.sans[700], color: '#ffffff' },
  statusNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: Radius.md,
    paddingVertical: Spacing.two,
  },
  statusNoteText: { fontSize: 12, fontFamily: Fonts.sans[700] },
});
