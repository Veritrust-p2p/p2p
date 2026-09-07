import { Redirect } from 'expo-router';

/**
 * Default entry point for signed-in sessions.
 *
 * When an authenticated user launches the app, Expo Router routes `/`
 * to the `(app)` group. This redirects them directly to the main tab home.
 */
export default function AppIndex() {
  return <Redirect href="/home" />;
}
