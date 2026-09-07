import { Redirect } from 'expo-router';
import { useAuth } from '@/context/AuthContext';

/** Entry point for public routes: authenticated users go to home, others to splash. */
export default function PublicIndexRedirect() {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) {
    return <Redirect href="/home" />;
  }
  return <Redirect href="/splash" />;
}

