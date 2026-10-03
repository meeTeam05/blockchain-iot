import { Tabs } from 'expo-router';

import { AtmosphereBottomNav } from '@/components/shell/AtmosphereBottomNav';


export default function AppShellLayout() {

  return (

    <Tabs

      tabBar={(props) => (
        <AtmosphereBottomNav {...props} />
      )}

      screenOptions={{
        headerShown: false,
      }}

    >

      <Tabs.Screen
        name="home"
      />

      <Tabs.Screen
        name="notifications"
      />

      <Tabs.Screen
        name="profile"
      />

    </Tabs>

  );

}