/**
 * @file sht3x.c
 *
 * @brief SHT3x Temperature and Humidity Sensor Driver Implementation
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "sht3x.h"
#include "esp_log.h"
#include "driver/i2c_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include <string.h>

#define TIME_TO_TICKS(ms) (1 + ((ms) + (portTICK_PERIOD_MS - 1) + portTICK_PERIOD_MS / 2) / portTICK_PERIOD_MS)

#define CHECK(x)                                                           \
    do {                                                                   \
        esp_err_t __err = (x);                                             \
        if (__err != ESP_OK) {                                             \
            ESP_LOGE(TAG, "Operation failed: %s", esp_err_to_name(__err)); \
            return __err;                                                  \
        }                                                                  \
    } while (0)

#define CHECK_ARG(VAL)                         \
    do {                                       \
        if (!(VAL)) {                          \
            ESP_LOGE(TAG, "Invalid argument"); \
            return ESP_ERR_INVALID_ARG;        \
        }                                      \
    } while (0)

/* SHT3x command codes */
#define SHT3X_STATUS_CMD             0xF32D  //!< Read status register
#define SHT3X_CLEAR_STATUS_CMD       0x3041  //!< Clear status register
#define SHT3X_RESET_CMD              0x30A2  //!< Soft reset
#define SHT3X_FETCH_DATA_CMD         0xE000  //!< Fetch measurement data
#define SHT3X_STOP_PERIODIC_MEAS_CMD 0x3093  //!< Stop periodic measurement
#define SHT3X_HEATER_ON_CMD          0x306D  //!< Turn heater on
#define SHT3X_HEATER_OFF_CMD         0x3066  //!< Turn heater off

/* Measurement durations in milliseconds */
#define SHT3X_MEAS_DURATION_REP_HIGH   15  //!< High repeatability
#define SHT3X_MEAS_DURATION_REP_MEDIUM 6   //!< Medium repeatability
#define SHT3X_MEAS_DURATION_REP_LOW    4   //!< Low repeatability

/* CRC-8 polynomial */
#define G_POLYNOM 0x31

/* I2C configuration */
#define I2C_FREQ_HZ    SA_I2C_FREQ_HZ
#define I2C_TIMEOUT_MS SA_I2C_TIMEOUT_MS

static const char *TAG = "sht3x";

/* Measurement commands: [mode][repeatability (H/M/L)] */
static const uint16_t SHT3X_MEASURE_CMD[6][3] = {
    {0x2400, 0x240b, 0x2416},  //!< [SINGLE_SHOT][H,M,L] without clock stretching
    {0x2032, 0x2024, 0x202f},  //!< [PERIODIC_05][H,M,L] 0.5 measurements per second
    {0x2130, 0x2126, 0x212d},  //!< [PERIODIC_1 ][H,M,L] 1 measurement per second
    {0x2236, 0x2220, 0x222b},  //!< [PERIODIC_2 ][H,M,L] 2 measurements per second
    {0x2334, 0x2322, 0x2329},  //!< [PERIODIC_4 ][H,M,L] 4 measurements per second
    {0x2737, 0x2721, 0x272a}   //!< [PERIODIC_10][H,M,L] 10 measurements per second
};

/* measurement durations in us */
static const uint16_t SHT3X_MEAS_DURATION_US[3] = {
    SHT3X_MEAS_DURATION_REP_HIGH * 1000, SHT3X_MEAS_DURATION_REP_MEDIUM * 1000, SHT3X_MEAS_DURATION_REP_LOW * 1000};

/* measurement durations in RTOS ticks */
static const uint8_t SHT3X_MEAS_DURATION_TICKS[3] = {TIME_TO_TICKS(SHT3X_MEAS_DURATION_REP_HIGH),
                                                     TIME_TO_TICKS(SHT3X_MEAS_DURATION_REP_MEDIUM),
                                                     TIME_TO_TICKS(SHT3X_MEAS_DURATION_REP_LOW)};

/**
 * @brief Shuffle bytes in a 16-bit value
 *
 * @param[in] val 16-bit value
 *
 * @return Shuffled 16-bit value
 */
static inline uint16_t shuffle(uint16_t val);

/**
 * @brief Compute CRC8 checksum for data array
 *
 * @param[in] data Data array
 * @param[in] len Length of data array
 *
 * @return Computed CRC8 checksum
 */
static uint8_t crc8(uint8_t data[], int len);

/**
 * @brief Write raw bytes to SHT3x without taking mutex
 *
 * @param[in] dev Pointer to device descriptor
 * @param[in] data Data to write
 * @param[in] len Number of bytes to write
 *
 * @return ESP_OK on success, error code otherwise
 */
static esp_err_t write_nolock(sht3x_t *dev, const void *data, size_t len);

/**
 * @brief Read raw bytes from SHT3x without taking mutex
 *
 * @param[in] dev Pointer to device descriptor
 * @param[out] data Buffer to store read data
 * @param[in] len Number of bytes to read
 *
 * @return ESP_OK on success, error code otherwise
 */
static esp_err_t read_nolock(sht3x_t *dev, void *data, size_t len);

/**
 * @brief Send command to SHT3x without taking mutex
 *
 * @param[in] dev Pointer to device descriptor
 * @param[in] cmd Command to send
 *
 * @return ESP_OK on success, error code otherwise
 */
static esp_err_t send_cmd_nolock(sht3x_t *dev, uint16_t cmd);

/**
 * @brief Send command to SHT3x
 *
 * @param[in] dev Pointer to device descriptor
 * @param[in] cmd Command to send
 *
 * @return ESP_OK on success, error code otherwise
 */
static esp_err_t send_cmd(sht3x_t *dev, uint16_t cmd);

/**
 * @brief Start the measurement in single shot or periodic mode without taking mutex
 *
 * @param[in] dev Device descriptor
 * @param[in] mode Measurement mode, see type ::sht3x_mode_t
 * @param[in] repeat Repeatability, see type ::sht3x_repeat_t
 *
 * @return ESP_OK on success, error code otherwise
 */
static esp_err_t start_nolock(sht3x_t *dev, sht3x_mode_t mode, sht3x_repeat_t repeat);

/**
 * @brief Check if measurement is in progress
 *
 * @param[in] dev Device descriptor
 *
 * @return true if measurement is in progress, false otherwise
 */
static inline bool is_measuring(sht3x_t *dev);

/**
 * @brief Read measurement results from sensor as raw data without taking mutex
 *
 * @param[in] dev Device descriptor
 * @param[out] raw_data  Byte array in which raw data are stored
 *
 * @return ESP_OK on success, error code otherwise
 */
static esp_err_t get_raw_data_nolock(sht3x_t *dev, sht3x_raw_data_t raw_data);

/* External functions */

/**
 * @brief Initialize SHT3x device descriptor
 */
esp_err_t sht3x_init_desc(sht3x_t *dev, uint8_t addr, i2c_port_t port, gpio_num_t sda_gpio, gpio_num_t scl_gpio)
{
    CHECK_ARG(dev);

    if (addr != SHT3X_I2C_ADDR_GND && addr != SHT3X_I2C_ADDR_VDD) {
        ESP_LOGE(TAG, "Invalid I2C address: 0x%02x (must be 0x44 or 0x45)", addr);
        return ESP_ERR_INVALID_ARG;
    }

    ESP_LOGI(TAG, "Initializing SHT3x");

    dev->i2c_dev.port = port;
    dev->i2c_dev.addr = addr;
    dev->i2c_dev.sda_io_num = sda_gpio;
    dev->i2c_dev.scl_io_num = scl_gpio;
    dev->i2c_dev.clk_speed = I2C_FREQ_HZ;

    esp_err_t res = i2c_dev_create_mutex(&dev->i2c_dev);
    if (res == ESP_OK) {
        ESP_LOGI(TAG,
                 "SHT3x initialized on port %d (addr: 0x%02x, SDA: GPIO%d, SCL: GPIO%d)",
                 port,
                 addr,
                 sda_gpio,
                 scl_gpio);
    } else {
        ESP_LOGE(TAG, "Failed to initialize SHT3x: %s", esp_err_to_name(res));
    }

    return res;
}

/**
 * @brief Free SHT3x device descriptor
 */
esp_err_t sht3x_free_desc(sht3x_t *dev)
{
    CHECK_ARG(dev);

    ESP_LOGD(TAG, "Freeing SHT3x descriptor");
    esp_err_t ret = i2c_dev_delete_mutex(&dev->i2c_dev);
    if (ret == ESP_OK) {
        ESP_LOGD(TAG, "SHT3x descriptor freed successfully");
    }
    return ret;
}

/**
 * @brief Initialize SHT3x sensor
 */
esp_err_t sht3x_init(sht3x_t *dev)
{
    CHECK_ARG(dev);

    dev->mode = SHT3X_SINGLE_SHOT;
    dev->meas_start_time = 0;
    dev->meas_started = false;
    dev->meas_first = false;

    esp_err_t res = send_cmd(dev, SHT3X_CLEAR_STATUS_CMD);
    if (res == ESP_OK) {
        ESP_LOGD(TAG, "SHT3x sensor initialized successfully");
    } else {
        ESP_LOGE(TAG, "Failed to initialize SHT3x sensor: %s", esp_err_to_name(res));
    }

    return res;
}

/**
 * @brief Enable or disable the internal heater
 */
esp_err_t sht3x_set_heater(sht3x_t *dev, bool enable)
{
    CHECK_ARG(dev);

    esp_err_t res = send_cmd(dev, enable ? SHT3X_HEATER_ON_CMD : SHT3X_HEATER_OFF_CMD);
    if (res == ESP_OK) {
        ESP_LOGI(TAG, "Heater %s", enable ? "enabled" : "disabled");
    } else {
        ESP_LOGE(TAG, "Failed to %s heater: %s", enable ? "enable" : "disable", esp_err_to_name(res));
    }

    return res;
}

/**
 * @brief Compute temperature and humidity from raw data
 */
esp_err_t sht3x_compute_values(sht3x_raw_data_t raw_data, float *temperature, float *humidity)
{
    CHECK_ARG(raw_data);

    if (!temperature && !humidity) {
        ESP_LOGE(TAG, "Both temperature and humidity pointers are NULL");
        return ESP_ERR_INVALID_ARG;
    }

    if (temperature)
        *temperature = ((((raw_data[0] * 256.0) + raw_data[1]) * 175) / 65535.0) - 45;

    if (humidity)
        *humidity = ((((raw_data[3] * 256.0) + raw_data[4]) * 100) / 65535.0);

    return ESP_OK;
}

/**
 * @brief Perform a single-shot measurement and get temperature and humidity
 */
esp_err_t sht3x_measure(sht3x_t *dev, float *temperature, float *humidity)
{
    CHECK_ARG(dev && (temperature || humidity));

    sht3x_raw_data_t raw_data;

    ESP_LOGD(TAG, "Starting single-shot measurement");
    I2C_DEV_TAKE_MUTEX(&dev->i2c_dev);
    esp_err_t ret = start_nolock(dev, SHT3X_SINGLE_SHOT, SHT3X_HIGH);
    if (ret != ESP_OK) {
        I2C_DEV_GIVE_MUTEX(&dev->i2c_dev);
        ESP_LOGE(TAG, "Operation failed: %s", esp_err_to_name(ret));
        return ret;
    }

    vTaskDelay(SHT3X_MEAS_DURATION_TICKS[SHT3X_HIGH]);
    ret = get_raw_data_nolock(dev, raw_data);
    I2C_DEV_GIVE_MUTEX(&dev->i2c_dev);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Operation failed: %s", esp_err_to_name(ret));
        return ret;
    }

    esp_err_t res = sht3x_compute_values(raw_data, temperature, humidity);
    if (res == ESP_OK && temperature && humidity) {
        ESP_LOGD(TAG, "Measurement complete: T=%.2f°C, H=%.2f%%", *temperature, *humidity);
    }

    return res;
}

/**
 * @brief Get measurement duration in RTOS ticks for given repeatability
 */
uint8_t sht3x_get_measurement_duration(sht3x_repeat_t repeat)
{
    return SHT3X_MEAS_DURATION_TICKS[repeat]; /* in RTOS ticks */
}

/**
 * @brief Start the measurement in single shot or periodic mode
 */
esp_err_t sht3x_start_measurement(sht3x_t *dev, sht3x_mode_t mode, sht3x_repeat_t repeat)
{
    CHECK_ARG(dev);

    /* Validate mode */
    if (mode < SHT3X_SINGLE_SHOT || mode > SHT3X_PERIODIC_10MPS) {
        ESP_LOGE(TAG, "Invalid mode: %d (must be 0-5)", mode);
        return ESP_ERR_INVALID_ARG;
    }

    /* Validate repeatability */
    if (repeat < SHT3X_HIGH || repeat > SHT3X_LOW) {
        ESP_LOGE(TAG, "Invalid repeatability: %d (must be 0-2)", repeat);
        return ESP_ERR_INVALID_ARG;
    }

    I2C_DEV_TAKE_MUTEX(&dev->i2c_dev);
    esp_err_t ret = start_nolock(dev, mode, repeat);
    I2C_DEV_GIVE_MUTEX(&dev->i2c_dev);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Operation failed: %s", esp_err_to_name(ret));
        return ret;
    }

    const char *mode_str[] = {"single-shot", "0.5mps", "1mps", "2mps", "4mps", "10mps"};
    const char *repeat_str[] = {"high", "medium", "low"};
    ESP_LOGI(TAG,
             "Started %s measurement (repeatability: %s, port=%d, addr=0x%02x)",
             mode_str[mode],
             repeat_str[repeat],
             dev->i2c_dev.port,
             dev->i2c_dev.addr);

    return ESP_OK;
}

/**
 * @brief Stop the periodic mode measurements
 */
esp_err_t sht3x_stop_periodic_measurement(sht3x_t *dev)
{
    CHECK_ARG(dev);

    ESP_LOGD(TAG, "Stopping periodic measurement");
    I2C_DEV_TAKE_MUTEX(&dev->i2c_dev);
    esp_err_t ret = send_cmd_nolock(dev, SHT3X_STOP_PERIODIC_MEAS_CMD);
    if (ret != ESP_OK) {
        I2C_DEV_GIVE_MUTEX(&dev->i2c_dev);
        ESP_LOGE(TAG, "Operation failed: %s", esp_err_to_name(ret));
        return ret;
    }

    dev->mode = SHT3X_SINGLE_SHOT;
    dev->meas_start_time = 0;
    dev->meas_started = false;
    dev->meas_first = false;
    I2C_DEV_GIVE_MUTEX(&dev->i2c_dev);

    ESP_LOGI(TAG, "Periodic measurement stopped");
    return ESP_OK;
}

/**
 * @brief Read measurement results from sensor as raw data
 */
esp_err_t sht3x_get_raw_data(sht3x_t *dev, sht3x_raw_data_t raw_data)
{
    CHECK_ARG(dev && raw_data);

    I2C_DEV_TAKE_MUTEX(&dev->i2c_dev);
    esp_err_t ret = get_raw_data_nolock(dev, raw_data);
    I2C_DEV_GIVE_MUTEX(&dev->i2c_dev);
    return ret;
}

/**
 * @brief Get temperature and humidity from the last measurement
 */
esp_err_t sht3x_get_results(sht3x_t *dev, float *temperature, float *humidity)
{
    CHECK_ARG(dev && (temperature || humidity));

    sht3x_raw_data_t raw_data;

    CHECK(sht3x_get_raw_data(dev, raw_data));

    return sht3x_compute_values(raw_data, temperature, humidity);
}

/* Private functions */

static inline uint16_t shuffle(uint16_t val)
{
    return (val >> 8) | (val << 8);
}

static uint8_t crc8(uint8_t data[], int len)
{
    /* initialization value */
    uint8_t crc = 0xff;

    /* iterate over all bytes */
    for (int i = 0; i < len; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            bool do_xor = crc & 0x80;
            crc = crc << 1;
            crc = do_xor ? crc ^ G_POLYNOM : crc;
        }
    }
    return crc;
}

static esp_err_t write_nolock(sht3x_t *dev, const void *data, size_t len)
{
    if (!dev || !data || len == 0) {
        ESP_LOGE(TAG, "Invalid write arguments");
        return ESP_ERR_INVALID_ARG;
    }

    if (dev->i2c_dev.dev_handle == NULL) {
        ESP_LOGE(TAG, "Device 0x%02x not initialized", dev->i2c_dev.addr);
        return ESP_ERR_INVALID_STATE;
    }

    i2c_master_dev_handle_t dev_handle = (i2c_master_dev_handle_t)dev->i2c_dev.dev_handle;
    esp_err_t ret = i2c_master_transmit(dev_handle, (const uint8_t *)data, len, I2C_TIMEOUT_MS);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "I2C write failed to addr 0x%02x: %s", dev->i2c_dev.addr, esp_err_to_name(ret));
    }

    return ret;
}

static esp_err_t read_nolock(sht3x_t *dev, void *data, size_t len)
{
    if (!dev || !data || len == 0) {
        ESP_LOGE(TAG, "Invalid read arguments");
        return ESP_ERR_INVALID_ARG;
    }

    if (dev->i2c_dev.dev_handle == NULL) {
        ESP_LOGE(TAG, "Device 0x%02x not initialized", dev->i2c_dev.addr);
        return ESP_ERR_INVALID_STATE;
    }

    i2c_master_dev_handle_t dev_handle = (i2c_master_dev_handle_t)dev->i2c_dev.dev_handle;
    esp_err_t ret = i2c_master_receive(dev_handle, (uint8_t *)data, len, I2C_TIMEOUT_MS);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "I2C read failed from addr 0x%02x: %s", dev->i2c_dev.addr, esp_err_to_name(ret));
    }

    return ret;
}

static esp_err_t send_cmd_nolock(sht3x_t *dev, uint16_t cmd)
{
    cmd = shuffle(cmd);

    return write_nolock(dev, &cmd, sizeof(cmd));
}

static esp_err_t send_cmd(sht3x_t *dev, uint16_t cmd)
{
    I2C_DEV_TAKE_MUTEX(&dev->i2c_dev);
    esp_err_t ret = send_cmd_nolock(dev, cmd);
    I2C_DEV_GIVE_MUTEX(&dev->i2c_dev);
    return ret;
}

static esp_err_t start_nolock(sht3x_t *dev, sht3x_mode_t mode, sht3x_repeat_t repeat)
{
    dev->mode = mode;
    dev->repeatability = repeat;
    CHECK(send_cmd_nolock(dev, SHT3X_MEASURE_CMD[mode][repeat]));
    dev->meas_start_time = esp_timer_get_time();
    dev->meas_started = true;
    dev->meas_first = true;

    return ESP_OK;
}

static inline bool is_measuring(sht3x_t *dev)
{
    /* not running if measurement is not started at all or */
    /* it is not the first measurement in periodic mode */
    if (!dev->meas_started || !dev->meas_first)
        return false;

    /* not running if time elapsed is greater than duration */
    uint64_t elapsed = esp_timer_get_time() - dev->meas_start_time;

    return elapsed < SHT3X_MEAS_DURATION_US[dev->repeatability];
}

static esp_err_t get_raw_data_nolock(sht3x_t *dev, sht3x_raw_data_t raw_data)
{
    if (!dev->meas_started) {
        ESP_LOGE(TAG, "Measurement is not started");
        return ESP_ERR_INVALID_STATE;
    }
    if (is_measuring(dev)) {
        ESP_LOGE(TAG, "Measurement is still running");
        return ESP_ERR_INVALID_STATE;
    }

    if (dev->mode != SHT3X_SINGLE_SHOT) {
        /* Periodic mode requires FETCH_DATA before readout. */
        uint16_t cmd = shuffle(SHT3X_FETCH_DATA_CMD);
        CHECK(write_nolock(dev, &cmd, sizeof(cmd)));
    }

    /* Single-shot reads data directly after conversion delay. */
    CHECK(read_nolock(dev, raw_data, sizeof(sht3x_raw_data_t)));

    /* reset first measurement flag */
    dev->meas_first = false;

    /* reset measurement started flag in single shot mode */
    if (dev->mode == SHT3X_SINGLE_SHOT)
        dev->meas_started = false;

    /* check temperature crc */
    if (crc8(raw_data, 2) != raw_data[2]) {
        ESP_LOGE(TAG, "CRC check for temperature data failed");
        return ESP_ERR_INVALID_CRC;
    }

    /* check humidity crc */
    if (crc8(raw_data + 3, 2) != raw_data[5]) {
        ESP_LOGE(TAG, "CRC check for humidity data failed");
        return ESP_ERR_INVALID_CRC;
    }

    return ESP_OK;
}
