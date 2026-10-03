set(incident_sources "incident.c")

if(CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH)
    list(APPEND incident_sources "incident_signer_provision_bench.c")
endif()

idf_component_register(
    SRCS ${incident_sources}
    INCLUDE_DIRS "include"
    REQUIRES config freertos json mbedtls nvs_flash sa_mqtt
    PRIV_REQUIRES esp_rom
)
