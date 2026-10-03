import { Redirect } from 'expo-router';

import { useAuthStore } from '@/stores/authStore';

export default function Index() {
  const status = useAuthStore((s) => s.status);

  if (status === 'loading') return null;

  return <Redirect href={status === 'authenticated' ? '/home' : '/login'} />;
}
