import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors } from '@/theme/useColors';
import { AppColors } from '@/theme/appColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTokens } from '@/theme/tokens';



type BottomNavProps = {
  state: {
    index: number;
    routes: {
      name: string;
    }[];
  };

  navigation: {
    navigate: (name: string) => void;
  };
};



const NAV_ITEMS = [
  {
    name: 'home',
    label: 'Home',
    icon: AppIcons.home,
  },

  {
    name: 'notifications',
    label: 'Notifications',
    icon: AppIcons.notifications,
  },

  {
    name: 'profile',
    label: 'Profile',
    icon: AppIcons.profile,
  },
];



export function AtmosphereBottomNav({
  state,
  navigation,
}: BottomNavProps) {


  const c = useColors();
  const insets = useSafeAreaInsets();



  return (

    <View

      style={[
        styles.container,
        {
          backgroundColor: c.surface,
          borderTopColor: c.border,
          paddingBottom: 8 + insets.bottom,
        },
      ]}

    >

      {
        NAV_ITEMS.map((item) => {


          const routeIndex =
            state.routes.findIndex(
              (route) =>
                route.name === item.name
            );


          if (routeIndex === -1) {
            return null;
          }



          const focused =
            state.index === routeIndex;



          const Icon = item.icon;



          return (

            <Pressable

              key={item.name}

              style={styles.item}

              onPress={() => {

                navigation.navigate(
                  item.name
                );

              }}

            >


              <View

                style={[
                  styles.iconContainer,

                  focused && {
                    backgroundColor:
                      AtmosphereTokens.brandTint2,
                  },
                ]}

              >

                <Icon

                  size={22}

                  color={
                    focused
                      ? AppColors.primary
                      : c.textSecondary
                  }

                />

              </View>



              <Text

                style={[
                  styles.label,

                  {
                    color:
                      focused
                        ? AppColors.primary
                        : c.textSecondary,
                  },

                  focused &&
                    styles.activeLabel,

                ]}

              >

                {item.label}

              </Text>


            </Pressable>

          );

        })
      }


    </View>

  );

}



const styles = StyleSheet.create({

  container: {

    minHeight: 72,

    flexDirection: 'row',

    alignItems: 'center',

    justifyContent: 'space-around',

    borderTopWidth: 1,

    paddingBottom: 8,

  },


  item: {

    flex: 1,

    alignItems: 'center',

    justifyContent: 'center',

  },


  iconContainer: {

    width: 56,

    height: 32,

    borderRadius:
      AtmosphereTokens.radiusPill,

    alignItems: 'center',

    justifyContent: 'center',

  },


  label: {

    fontSize: 11,

    marginTop: 4,

  },


  activeLabel: {

    fontWeight: '600',

  },

});