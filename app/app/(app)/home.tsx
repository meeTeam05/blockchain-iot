import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useState } from 'react';
import { useRouter } from 'expo-router';

import { useColors } from '@/theme/useColors';
import { AppIcons } from '@/theme/icons';
import { withAlpha } from '@/theme/color';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';

import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { EmptyState } from '@/components/atoms/EmptyState';
import { DeviceCard } from '@/components/DeviceCard';

import { useDevices } from '@/queries/devices';
import { useHomes } from '@/queries/homes';

import type { Device } from '@/models/device';



export default function HomeScreen() {

  const c = useColors();

  const router = useRouter();


  const devicesQuery = useDevices();

  const homesQuery = useHomes();


  const [homePickerOpen, setHomePickerOpen] = useState(false);



  function handleAddDevice() {

    const homes = homesQuery.data ?? [];


    if (homesQuery.isLoading && homes.length === 0) {
      return;
    }


    if (homes.length === 0) {

      router.push('/homes/create');

      return;

    }


    if (homes.length === 1) {

      router.push({
        pathname: '/provision',
        params: {
          homeId: homes[0].id,
        },
      });

      return;

    }


    setHomePickerOpen(true);

  }



  const devices: Device[] = devicesQuery.data ?? [];

  return (

    <View
      style={[
        styles.screen,
        {
          backgroundColor: c.bg,
        },
      ]}
    >


      <AtmosphereAppBar
        variant="brand"
      />


      <View
        style={styles.headerBlock}
      >

        <Text
          style={AtmosphereTextStyles.pageTitle(c.ink)}
        >
          My Devices
        </Text>


        <View
          style={{
            height: AtmosphereTokens.space8,
          }}
        />


        <Text
          style={AtmosphereTextStyles.body(c.ink2)}
        >
          Real-time environmental monitoring across your connected spaces.
        </Text>


      </View>





      {
        devicesQuery.isLoading ? (

          <View
            style={styles.center}
          >

            <ActivityIndicator
              color={c.brand}
            />

          </View>


        ) : devicesQuery.isError ? (

          <EmptyState
            icon={AppIcons.warn}
            title="Failed to load devices"
            body={devicesQuery.error instanceof Error ? devicesQuery.error.message : 'Unknown error'}
            primaryAction="Retry"
            onPrimaryAction={() => devicesQuery.refetch()}
          />

        ) : devices.length === 0 ? (

          <EmptyState
            icon={AppIcons.device}
            title="No devices yet"
            body="Add your first device to start monitoring air quality in real time."
            primaryAction="Add a device"
            onPrimaryAction={handleAddDevice}
          />

        ) : (


          <FlatList

            data={devices}


            keyExtractor={(device) =>
              device.id
            }


            contentContainerStyle={
              styles.list
            }


            ItemSeparatorComponent={() => (

              <View
                style={{
                  height:
                    AtmosphereTokens.space16,
                }}
              />

            )}



            renderItem={({ item }) => (

              <DeviceCard

                device={item}

                onPress={() =>

                  router.push(
                    `/devices/${item.id}`
                  )

                }

              />

            )}

          />


        )
      }






      <Pressable

        onPress={handleAddDevice}

        style={[
          styles.fab,
          {
            backgroundColor:c.mint,
          },
        ]}

      >

        <AppIcons.plus

          size={28}

          color={c.brand}

        />


      </Pressable>






      {
        homePickerOpen && (

          <View
            style={styles.sheetBackdrop}
          >

            <Pressable

              style={StyleSheet.absoluteFill}

              onPress={() =>
                setHomePickerOpen(false)
              }

            />


            <View

              style={[
                styles.sheet,
                {
                  backgroundColor:c.surface,
                },
              ]}

            >

              <Text
                style={
                  AtmosphereTextStyles.h2(c.ink)
                }
              >
                Choose a home
              </Text>



              {
                (homesQuery.data ?? []).map(
                  (home) => (

                    <Pressable

                      key={home.id}

                      style={styles.sheetRow}


                      onPress={() => {

                        setHomePickerOpen(false);


                        router.push({

                          pathname:'/provision',

                          params:{
                            homeId:home.id,
                          },

                        });

                      }}

                    >

                      <Text
                        style={
                          AtmosphereTextStyles.body(c.ink)
                        }
                      >

                        {home.name}

                      </Text>


                    </Pressable>

                  )
                )
              }


            </View>


          </View>

        )
      }



    </View>

  );

}




const styles = StyleSheet.create({

  screen:{
    flex:1,
  },


  headerBlock:{

    paddingHorizontal:
      AtmosphereTokens.space20,

    paddingTop:
      AtmosphereTokens.space24,

    paddingBottom:
      AtmosphereTokens.space12,

  },


  center:{

    flex:1,

    justifyContent:'center',

    alignItems:'center',

  },


  list:{

    paddingHorizontal:
      AtmosphereTokens.space20,

    paddingBottom:
      AtmosphereTokens.space32,

  },


  fab:{

    position:'absolute',

    right:20,

    bottom:20,

    width:56,

    height:56,

    borderRadius:28,

    alignItems:'center',

    justifyContent:'center',

  },


  sheetBackdrop:{

    position:'absolute',

    top:0,

    left:0,

    right:0,

    bottom:0,

    justifyContent:'flex-end',

    backgroundColor:
      withAlpha('#0E1F1B',0.4),

  },


  sheet:{

    padding:
      AtmosphereTokens.space20,

    borderTopLeftRadius:
      AtmosphereTokens.radiusCard,

    borderTopRightRadius:
      AtmosphereTokens.radiusCard,

  },


  sheetRow:{

    paddingVertical:
      AtmosphereTokens.space12,

  },


});