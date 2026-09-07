import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Bell, MessageSquare, Wallet } from '@/components/icons';

import { Pressable } from '@/components/ui/pressable';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/context/AuthContext';
import { useConversations } from '@/features/messages/data/messagesApi';
import { useUnreadNotifications } from '@/features/notifications/data/notificationsApi';

/**
 * The app bar every signed-in home screen wears: avatar on the left, wallet,
 * messages and notifications on the right.
 *
 * Lifted out of `SellerDashboard`, which is where this pattern was first built
 * and still the reference for it. Same three destinations as the web header
 * (`web/src/features/shared/ui/Layout.tsx`) — profile, messages, notifications
 * — and the same live badge counts, so the console and the merchant portal
 * can't drift into looking like two different apps.
 *
 * Both counts come from data the screens already fetch: messages sum the
 * per-conversation unread counts the inbox returns, notifications read the
 * `unread` total the list endpoint carries on every response. Neither costs an
 * extra request.
 *
 * Wallet is opt-in rather than always drawn. This bar is worn by the admin
 * console too, and an admin has no wallet to open — the balance, top-ups and
 * withdrawals it leads to are a buyer/seller concern. So the caller says
 * whether the icon belongs, and only the buyer home passes it today.
 *
 * It sits to the *left* of the pair rather than on the outside edge, which
 * leaves Messages and Bell on exactly the pixels they already occupied and
 * keeps the two badge-carrying icons adjacent. No badge of its own: a balance
 * is a figure, not a count of things left unread, and a dot here would read as
 * money waiting to be collected.
 */
export interface AppBarProps {
  /** Draw the wallet icon. Off unless the screen actually has a wallet behind it. */
  showWallet?: boolean;
}

export function AppBar({ showWallet = false }: AppBarProps) {
  const theme = useTheme();
  const router = useRouter();
  const { user } = useAuth();

  const conversations = useConversations();
  const unreadMessages = (conversations.data ?? []).reduce((sum, c) => sum + c.unreadCount, 0);
  const unreadNotifications = useUnreadNotifications();

  // The bar is chrome, not content: with no session there's no avatar to draw
  // and nothing to count, so it stays out of the way rather than rendering a
  // blank circle.
  if (!user) return null;

  return (
    <View style={styles.appBar}>
      <Pressable
        onPress={() => router.push('/profile')}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Profile"
        style={({ pressed }) => [styles.avatarBtn, { opacity: pressed ? 0.7 : 1 }]}
      >
        {user.avatarUrl ? (
          <Image
            source={user.avatarUrl}
            style={[styles.headerAvatar, { borderColor: theme.cardBorder }]}
            contentFit="cover"
          />
        ) : (
          <View
            style={[
              styles.headerAvatar,
              styles.avatarFallback,
              { backgroundColor: theme.primary, borderColor: theme.cardBorder },
            ]}
          >
            <Text style={styles.avatarLetter}>
              {(user.fullName || user.username).charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
      </Pressable>

      <View style={styles.appBarActions}>
        {showWallet ? (
          <Pressable
            onPress={() => router.push('/wallet')}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Wallet"
            style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Wallet size={23} color={theme.text} />
          </Pressable>
        ) : null}

        <Pressable
          onPress={() => router.push('/messages')}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={unreadMessages > 0 ? `Messages, ${unreadMessages} unread` : 'Messages'}
          style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.5 : 1 }]}
        >
          <MessageSquare size={23} color={theme.text} />
          {unreadMessages > 0 ? (
            <View
              style={[
                styles.headerBadge,
                { backgroundColor: theme.primary, borderColor: theme.background },
              ]}
            >
              <Text style={styles.headerBadgeText}>
                {unreadMessages > 9 ? '9+' : unreadMessages}
              </Text>
            </View>
          ) : null}
        </Pressable>

        <Pressable
          onPress={() => router.push('/notifications')}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={
            unreadNotifications > 0
              ? `Notifications, ${unreadNotifications} unread`
              : 'Notifications'
          }
          style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.5 : 1 }]}
        >
          <Bell size={23} color={theme.text} />
          {unreadNotifications > 0 ? (
            <View
              style={[
                styles.headerBadge,
                { backgroundColor: theme.primary, borderColor: theme.background },
              ]}
            >
              <Text style={styles.headerBadgeText}>
                {unreadNotifications > 9 ? '9+' : unreadNotifications}
              </Text>
            </View>
          ) : null}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // App bar: avatar left, bare icons right.
  /**
   * No vertical margin of its own. The seller screen this came from cancelled
   * part of its parent's 12px gap here, but that number only made sense for
   * that one parent — baked into a shared component it silently mis-spaces
   * every other caller. Spacing belongs to whoever places the bar.
   */
  appBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },

  // 20px apart — enough that neighbouring icons aren't mistapped, tight enough
  // that they read as one cluster.
  appBarActions: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  iconBtn: { alignItems: 'center', justifyContent: 'center' },
  avatarBtn: { alignItems: 'center', justifyContent: 'center' },
  /**
   * 44 is the minimum comfortable touch target on both platforms (Apple HIG and
   * Material both land there), and it reads as a deliberate profile anchor
   * rather than a stray dot.
   */
  headerAvatar: { height: 44, width: 44, borderRadius: Radius.full, borderWidth: 1 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { fontSize: 17, fontFamily: Fonts.sans[700], color: '#ffffff' },
  /** Rides the icon's top-right corner, ringed in the page colour so it reads
      as floating above rather than part of the glyph. */
  headerBadge: {
    position: 'absolute',
    top: -6,
    right: -8,
    minWidth: 17,
    height: 17,
    borderRadius: Radius.full,
    paddingHorizontal: 4,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBadgeText: { fontSize: 10, fontFamily: Fonts.sans[700], color: '#ffffff' },
});
