set(srcs
    "ai.c"
    "ai_alarm_dispatch.c"
    "gas_ews.c"
)
set(embed_files "")

# The TFLite Micro wrapper and the embedded model are only built when the
# feature is enabled; ai.c provides no-op stubs otherwise. gas_ews.c is pure
# C99 (also built by the host tests in tools/).
if(CONFIG_SA_ENABLE_AI)
    list(APPEND srcs "gas_ews_model.cpp")
    list(APPEND embed_files "${CMAKE_CURRENT_LIST_DIR}/../../../../ai_model/gas_ews_int8.tflite")
endif()

idf_component_register(
    SRCS
        ${srcs}
    INCLUDE_DIRS
        "include"
    REQUIRES
        esp_common
    PRIV_REQUIRES
        buzzer
        config
        esp_timer
        freertos
        heap
        incident
        json
        mbedtls
        sa_mqtt
    EMBED_FILES
        ${embed_files}
)

# esp-tflite-micro is declared in idf_component.yml; the component manager
# adds it to this component's requirements automatically.
