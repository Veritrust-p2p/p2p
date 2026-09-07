import { useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { LogoMark } from '@/components/brand/logo-mark';

import { Fonts, Primary } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';

/**
 * Loading screen — the first thing the app shows.
 *
 * Shows the web app's actual brand mark — the same artwork, ported path for
 * path in `@/components/brand/logo-mark` — on the dark canvas the rest of the
 * app boots on. The web footer sits the same mark on an even darker slate-950,
 * so it reads fine here without a plate behind it. It animates in, holds,
 * then hands off to /home if authenticated, or /login if not.
 *
 * Colours are hard-coded rather than themed on purpose — this canvas is dark in
 * both light and dark mode, so themed text would go invisible in light mode.
 */

/** How long the brand sits on screen before we route away (ms). */
const HOLD_MS = 2200;
/** Length of the fade-out that covers the navigation (ms). */
const EXIT_MS = 400;

/**
 * Turns the 0→1→0 pulse into a soft wave for one dot. `offset` staggers each
 * dot along the wave. Runs on the UI thread, hence the worklet directive.
 */
function waveStyle(pulse: number, offset: number) {
  'worklet';
  const wave = Math.max(0, Math.sin((pulse + offset) * Math.PI));
  return { opacity: 0.25 + wave * 0.75, transform: [{ scale: 0.85 + wave * 0.35 }] };
}

export function LoadingScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  // Kept in a ref so the hand-off timer below reads the live route, not the
  // value captured when the effect ran.
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const authRef = useRef(isAuthenticated);
  authRef.current = isAuthenticated;

  // Shared values are the numbers Reanimated animates on the UI thread.
  const logoScale = useSharedValue(0.6);
  const logoOpacity = useSharedValue(0);
  const textOpacity = useSharedValue(0);
  const textShift = useSharedValue(16);
  const pulse = useSharedValue(0);

  useEffect(() => {
    // 1. Logo springs in.
    logoScale.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.back(1.4)) });
    logoOpacity.value = withTiming(1, { duration: 500 });

    // 2. Wordmark fades up just behind it.
    textOpacity.value = withDelay(320, withTiming(1, { duration: 500 }));
    textShift.value = withDelay(320, withTiming(0, { duration: 500, easing: Easing.out(Easing.ease) }));

    // 3. The "still working" pulse loops until we leave (-1 = forever).
    pulse.value = withDelay(
      600,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      ),
    );

    // 4. Fade everything out, then swap the route underneath the fade.
    const fadeOut = setTimeout(() => {
      logoOpacity.value = withTiming(0, { duration: EXIT_MS });
      textOpacity.value = withTiming(0, { duration: EXIT_MS });
      logoScale.value = withTiming(0.94, { duration: EXIT_MS });
    }, HOLD_MS);

    const leave = setTimeout(() => {
      // A deep link — a scanned join QR, say — can land the app elsewhere while
      // this timer is still pending. Only hand off if the splash is still what's
      // on screen, otherwise we'd stomp the link.
      if (pathRef.current !== '/splash') return;
      // `replace` instead of `push` so the back gesture can't return here.
      router.replace(authRef.current ? '/home' : '/login');
    }, HOLD_MS + EXIT_MS);

    return () => {
      clearTimeout(fadeOut);
      clearTimeout(leave);
    };
  }, [router, logoScale, logoOpacity, textOpacity, textShift, pulse]);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  const textStyle = useAnimatedStyle(() => ({
    opacity: textOpacity.value,
    transform: [{ translateY: textShift.value }],
  }));

  // One shared pulse drives all three dots; each dot reads it with a small
  // offset so they ripple instead of blinking in unison. These are three
  // separate hooks (not a loop or helper) because hooks must be called at the
  // top level, the same number of times, on every render.
  const dotOne = useAnimatedStyle(() => waveStyle(pulse.value, 0));
  const dotTwo = useAnimatedStyle(() => waveStyle(pulse.value, 0.22));
  const dotThree = useAnimatedStyle(() => waveStyle(pulse.value, 0.44));

  return (
    <View style={styles.container}>
      <View style={styles.center}>
        <Animated.View style={[styles.logoWrap, logoStyle]}>
          <LogoMark height={96} />
        </Animated.View>

        <Animated.View style={[styles.copy, textStyle]}>
          <Text style={styles.title}>VeriTrust</Text>
          <Text style={styles.subtitle}>Secure escrow for every deal</Text>
        </Animated.View>
      </View>

      <Animated.View style={[styles.dots, textStyle]}>
        <Animated.View style={[styles.dot, dotOne]} />
        <Animated.View style={[styles.dot, dotTwo]} />
        <Animated.View style={[styles.dot, dotThree]} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#08121f',
  },
  center: {
    alignItems: 'center',
  },
  logoWrap: {
    alignItems: 'center',
  },
  copy: {
    marginTop: 24,
    alignItems: 'center',
  },
  // The wordmark under the logo. `LogoMark` is the symbol only — it carries no
  // text — so without this the splash shows the mark and a tagline with the
  // product's name nowhere on it.
  title: {
    fontSize: 22,
    fontFamily: Fonts.display[700],
    letterSpacing: -0.5,
    color: '#ffffff',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 22,
    fontFamily: Fonts.sans[400],
    color: '#94a3b8',
  },
  dots: {
    position: 'absolute',
    bottom: 72,
    flexDirection: 'row',
    gap: 8,
  },
  dot: {
    height: 7,
    width: 7,
    borderRadius: 999,
    backgroundColor: Primary[400],
  },
});
