cmake_minimum_required(VERSION 3.16)

set(IDF_TARGET esp32s3)

set(EXTRA_COMPONENT_DIRS
    components/core/ai
    components/config
    components/core/display_service
    components/core/device_mode
    components/core/sensor_task
    components/core/incident
    components/core/sysload
    components/general/ble_prov
    components/general/wifi
    components/general/sa_mqtt
    components/general/led
    components/general/factory_reset
    components/general/buzzer
    components/general/relay
    components/general/httpd
    components/drivers/i2c_bus
    components/drivers/i2c_devices/sht3x
    components/drivers/i2c_devices/ds3231
    components/drivers/adc_bus
    components/drivers/adc_devices/gm702b
    components/drivers/adc_devices/gm102b
    components/drivers/spi_bus
    components/drivers/spi_devices/ili9225
    components/ota
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(smart-air)
