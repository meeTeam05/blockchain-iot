set(display_service_srcs "display_service.c")

if(CONFIG_SA_ENABLE_ILI9225)
    list(APPEND display_service_srcs "logo.c")
endif()

idf_component_register(
    SRCS
        ${display_service_srcs}
    INCLUDE_DIRS
        "include"
    REQUIRES
        config
        ili9225
        lvgl
        wifi
    PRIV_REQUIRES
        esp_timer
        freertos
        log
)
