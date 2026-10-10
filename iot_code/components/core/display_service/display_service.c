/**
 * @file display_service.c
 *
 * @brief LVGL host for the optional ILI9225 display.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "display_service.h"

#include "config.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "ili9225.h"
#include "lvgl.h"
#include "wifi.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if SA_ENABLE_ILI9225

static const char *TAG = "display_service";

#define DISPLAY_LOGICAL_W           220
#define DISPLAY_LOGICAL_H           176
#define DISPLAY_NATIVE_W            ILI9225_PHYS_W
#define DISPLAY_NATIVE_H            ILI9225_PHYS_H
#define DISPLAY_BUF_LINES           16
#define DISPLAY_BUF_PIXELS          (DISPLAY_LOGICAL_W * DISPLAY_BUF_LINES)
#define DISPLAY_TICK_MS             5
#define DISPLAY_TASK_DELAY_MS       10
#define DISPLAY_UI_REFRESH_MS       250
#define DISPLAY_STATUSBAR_H         16
#define DISPLAY_VERSION_W           52
#define DISPLAY_CLOCK_H             56
#define DISPLAY_DATE_ROW_H          18
#define DISPLAY_SENSORS_H           (DISPLAY_LOGICAL_H - DISPLAY_STATUSBAR_H - DISPLAY_CLOCK_H - DISPLAY_DATE_ROW_H)
#define DISPLAY_SENSOR_CELL_W       (DISPLAY_LOGICAL_W / 4)
#define DISPLAY_TEXT_W              208
#define DISPLAY_MIN_VALID_UNIX_TS   946684800UL
#define DISPLAY_RELAY_COUNT         3
#define DISPLAY_SIGNAL_BAR_COUNT    4
#define DISPLAY_SELF_TEST_TICK_MS   20
#define DISPLAY_INIT_WAIT_BASE_MS   2000
#define DISPLAY_INIT_WAIT_MARGIN_MS 500
#define DISPLAY_OTA_HOLD_US         3000000LL
#define DISPLAY_OTA_DOT_STEP_US     350000LL

#define DISPLAY_COLOR_BG        0xFFFFFF
#define DISPLAY_COLOR_STATUS_BG 0xF1F3F6
#define DISPLAY_COLOR_DIVIDER   0xE4E7EC
#define DISPLAY_COLOR_TEXT      0x0F172A
#define DISPLAY_COLOR_MUTED     0x6B7280
#define DISPLAY_COLOR_FAINT     0x9AA3B2
#define DISPLAY_COLOR_ACCENT    0x2D7DD2
#define DISPLAY_COLOR_WARNING   0xD97706
#define DISPLAY_COLOR_DANGER    0xD32F2F

/* Fall back to compiled-in LVGL fonts so the display service builds with lean sdkconfig variants. */
#if CONFIG_LV_FONT_MONTSERRAT_10
#define DISPLAY_FONT_XS (&lv_font_montserrat_10)
#elif CONFIG_LV_FONT_MONTSERRAT_12
#define DISPLAY_FONT_XS (&lv_font_montserrat_12)
#else
#define DISPLAY_FONT_XS LV_FONT_DEFAULT
#endif

#if CONFIG_LV_FONT_MONTSERRAT_12
#define DISPLAY_FONT_SM (&lv_font_montserrat_12)
#elif CONFIG_LV_FONT_MONTSERRAT_14
#define DISPLAY_FONT_SM (&lv_font_montserrat_14)
#else
#define DISPLAY_FONT_SM LV_FONT_DEFAULT
#endif

#if CONFIG_LV_FONT_MONTSERRAT_14
#define DISPLAY_FONT_MD (&lv_font_montserrat_14)
#else
#define DISPLAY_FONT_MD LV_FONT_DEFAULT
#endif

#if CONFIG_LV_FONT_MONTSERRAT_18
#define DISPLAY_FONT_LG (&lv_font_montserrat_18)
#elif CONFIG_LV_FONT_MONTSERRAT_14
#define DISPLAY_FONT_LG (&lv_font_montserrat_14)
#else
#define DISPLAY_FONT_LG LV_FONT_DEFAULT
#endif

#if CONFIG_LV_FONT_MONTSERRAT_36
#define DISPLAY_FONT_CLOCK (&lv_font_montserrat_36)
#elif CONFIG_LV_FONT_MONTSERRAT_18
#define DISPLAY_FONT_CLOCK (&lv_font_montserrat_18)
#elif CONFIG_LV_FONT_MONTSERRAT_14
#define DISPLAY_FONT_CLOCK (&lv_font_montserrat_14)
#else
#define DISPLAY_FONT_CLOCK LV_FONT_DEFAULT
#endif

#if SA_DISP_SELF_TEST
#define DISPLAY_SELF_TEST_SCREEN_COUNT 4U
#else
#define DISPLAY_SELF_TEST_SCREEN_COUNT 0U
#endif

typedef struct {
    display_ota_state_t state;
    int64_t message_deadline_us;
} display_ota_runtime_t;

typedef struct {
    display_boot_phase_t phase;
    bool mode_known;
    bool mode_on;
    bool relay_states[DISPLAY_RELAY_COUNT];
    display_sensor_snapshot_t sensor;
    display_ota_runtime_t ota;
} display_state_t;

static SemaphoreHandle_t s_init_done = NULL;
static TaskHandle_t s_task = NULL;
static esp_timer_handle_t s_tick_timer = NULL;
static volatile bool s_ready = false;
static esp_err_t s_init_result = ESP_FAIL;
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static display_state_t s_state = {
    .phase = DISPLAY_BOOT_PHASE_BOOT,
};

static lv_disp_draw_buf_t s_draw_buf;
static lv_color_t *s_buf1 = NULL;
static lv_color_t *s_buf2 = NULL;
static uint8_t *s_swap_buf = NULL;

LV_IMG_DECLARE(LOGO);

typedef struct {
    lv_obj_t *value;
    lv_obj_t *sub;
} display_sensor_cell_t;

static lv_obj_t *s_boot_view = NULL;
static lv_obj_t *s_boot_logo = NULL;
static lv_obj_t *s_boot_status = NULL;
static lv_obj_t *s_ota_view = NULL;
static lv_obj_t *s_ota_title = NULL;
static lv_obj_t *s_ota_percent = NULL;
static lv_obj_t *s_ota_bar = NULL;
static lv_obj_t *s_ota_status = NULL;
static lv_obj_t *s_ota_note = NULL;
static lv_obj_t *s_runtime_view = NULL;
static lv_obj_t *s_status_ssid = NULL;
static lv_obj_t *s_status_rssi = NULL;
static lv_obj_t *s_signal_bars[DISPLAY_SIGNAL_BAR_COUNT] = {0};
static lv_obj_t *s_clock_hh = NULL;
static lv_obj_t *s_clock_mm = NULL;
static lv_obj_t *s_clock_ss = NULL;
static lv_obj_t *s_date_dow = NULL;
static lv_obj_t *s_date_value = NULL;
static display_sensor_cell_t s_sensor_cells[DISPLAY_SIGNAL_BAR_COUNT] = {0};

static const uint32_t SENSOR_ACCENT_COLORS[DISPLAY_SIGNAL_BAR_COUNT] = {
    0xE0524A,
    DISPLAY_COLOR_ACCENT,
    0x8B5CF6,
    0xD97706,
};

static const char *const SENSOR_LABELS[DISPLAY_SIGNAL_BAR_COUNT] = {
    "TEM",
    "HUM",
    "CO",
    "NO2",
};

static void lv_tick_cb(void *arg)
{
    (void)arg;
    lv_tick_inc(DISPLAY_TICK_MS);
}

static void snapshot_state(display_state_t *out)
{
    if (out == NULL) {
        return;
    }

    portENTER_CRITICAL(&s_state_lock);
    *out = s_state;
    portEXIT_CRITICAL(&s_state_lock);
}

static void set_hidden(lv_obj_t *obj, bool hidden)
{
    if (obj == NULL) {
        return;
    }

    if (hidden) {
        lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN);
        return;
    }

    lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);
}

static void style_text(lv_obj_t *obj, const lv_font_t *font, uint32_t color_hex)
{
    if (obj == NULL) {
        return;
    }

    lv_obj_set_style_text_font(obj, font, 0);
    lv_obj_set_style_text_color(obj, lv_color_hex(color_hex), 0);
}

static void prepare_panel_obj(lv_obj_t *obj, uint32_t bg_hex)
{
    lv_obj_remove_style_all(obj);
    lv_obj_set_style_bg_color(obj, lv_color_hex(bg_hex), 0);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
}

static void prepare_screen(lv_obj_t *scr, uint32_t bg_hex)
{
    lv_obj_set_style_bg_color(scr, lv_color_hex(bg_hex), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(scr, 0, 0);
    lv_obj_clear_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
}

static void clear_ota_runtime(display_ota_runtime_t *ota)
{
    if (ota == NULL) {
        return;
    }

    memset(ota, 0, sizeof(*ota));
    ota->state.stage = DISPLAY_OTA_STAGE_IDLE;
    ota->state.error = DISPLAY_OTA_ERROR_NONE;
}

static void refresh_ota_state(int64_t now_us)
{
    portENTER_CRITICAL(&s_state_lock);
    display_ota_runtime_t *ota = &s_state.ota;
    if (ota->state.error != DISPLAY_OTA_ERROR_NONE && ota->message_deadline_us > 0 &&
        now_us >= ota->message_deadline_us) {
        if (ota->state.error == DISPLAY_OTA_ERROR_BUSY && ota->state.active &&
            ota->state.stage != DISPLAY_OTA_STAGE_FAILED) {
            ota->state.error = DISPLAY_OTA_ERROR_NONE;
            ota->message_deadline_us = 0;
        } else {
            clear_ota_runtime(ota);
        }
    }
    portEXIT_CRITICAL(&s_state_lock);
}

static lv_obj_t *create_signal_bars(lv_obj_t *parent)
{
    lv_obj_t *wrap = lv_obj_create(parent);
    prepare_panel_obj(wrap, DISPLAY_COLOR_STATUS_BG);
    lv_obj_set_size(wrap, 11, 9);
    lv_obj_set_layout(wrap, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(wrap, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(wrap, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_END);
    lv_obj_set_style_pad_column(wrap, 1, 0);

    static const lv_coord_t bar_heights[DISPLAY_SIGNAL_BAR_COUNT] = {3, 5, 7, 9};
    for (size_t i = 0; i < DISPLAY_SIGNAL_BAR_COUNT; i++) {
        s_signal_bars[i] = lv_obj_create(wrap);
        prepare_panel_obj(s_signal_bars[i], DISPLAY_COLOR_FAINT);
        lv_obj_set_size(s_signal_bars[i], 2, bar_heights[i]);
    }

    return wrap;
}

static void create_sensor_cell(lv_obj_t *parent, size_t index)
{
    lv_obj_t *cell = lv_obj_create(parent);
    prepare_panel_obj(cell, DISPLAY_COLOR_BG);
    lv_obj_set_size(cell, DISPLAY_SENSOR_CELL_W, DISPLAY_SENSORS_H);
    if (index < (DISPLAY_SIGNAL_BAR_COUNT - 1U)) {
        lv_obj_set_style_border_side(cell, LV_BORDER_SIDE_RIGHT, 0);
        lv_obj_set_style_border_width(cell, 1, 0);
        lv_obj_set_style_border_color(cell, lv_color_hex(DISPLAY_COLOR_DIVIDER), 0);
    }

    lv_obj_t *header = lv_obj_create(cell);
    prepare_panel_obj(header, DISPLAY_COLOR_BG);
    lv_obj_set_style_bg_opa(header, LV_OPA_TRANSP, 0);
    lv_obj_set_size(header, DISPLAY_SENSOR_CELL_W, 12);
    lv_obj_align(header, LV_ALIGN_TOP_MID, 0, 6);
    lv_obj_set_layout(header, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(header, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(header, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(header, 3, 0);

    lv_obj_t *swatch = lv_obj_create(header);
    prepare_panel_obj(swatch, SENSOR_ACCENT_COLORS[index]);
    lv_obj_set_size(swatch, 5, 5);
    lv_obj_set_style_radius(swatch, 1, 0);

    lv_obj_t *label = lv_label_create(header);
    lv_label_set_text(label, SENSOR_LABELS[index]);
    style_text(label, DISPLAY_FONT_XS, DISPLAY_COLOR_MUTED);
    lv_obj_set_style_text_letter_space(label, 1, 0);

    s_sensor_cells[index].value = lv_label_create(cell);
    style_text(s_sensor_cells[index].value, DISPLAY_FONT_LG, DISPLAY_COLOR_TEXT);
    lv_obj_set_style_text_align(s_sensor_cells[index].value, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(s_sensor_cells[index].value, DISPLAY_SENSOR_CELL_W);
    lv_obj_align(s_sensor_cells[index].value, LV_ALIGN_CENTER, 0, -4);

    s_sensor_cells[index].sub = lv_label_create(cell);
    style_text(s_sensor_cells[index].sub, DISPLAY_FONT_XS, DISPLAY_COLOR_FAINT);
    lv_obj_set_style_text_align(s_sensor_cells[index].sub, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(s_sensor_cells[index].sub, DISPLAY_SENSOR_CELL_W);
    lv_obj_align(s_sensor_cells[index].sub, LV_ALIGN_BOTTOM_MID, 0, -8);
}

static void build_screen(void)
{
    lv_obj_t *scr = lv_scr_act();
    prepare_screen(scr, DISPLAY_COLOR_BG);

    s_boot_view = lv_obj_create(scr);
    prepare_panel_obj(s_boot_view, DISPLAY_COLOR_BG);
    lv_obj_set_size(s_boot_view, DISPLAY_LOGICAL_W, DISPLAY_LOGICAL_H);

    s_boot_logo = lv_img_create(s_boot_view);
    lv_img_set_src(s_boot_logo, &LOGO);
    lv_obj_align(s_boot_logo, LV_ALIGN_CENTER, 0, -10);

    lv_obj_t *boot_version = lv_label_create(s_boot_view);
    lv_label_set_text_fmt(boot_version, "%s", FIRMWARE_VERSION);
    style_text(boot_version, DISPLAY_FONT_XS, DISPLAY_COLOR_MUTED);
    lv_obj_set_style_text_align(boot_version, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(boot_version, LV_ALIGN_CENTER, 0, 50);

    s_boot_status = lv_label_create(s_boot_view);
    lv_obj_set_width(s_boot_status, DISPLAY_TEXT_W);
    style_text(s_boot_status, DISPLAY_FONT_SM, DISPLAY_COLOR_MUTED);
    lv_label_set_text(s_boot_status, "Booting");
    lv_label_set_long_mode(s_boot_status, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(s_boot_status, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_boot_status, LV_ALIGN_BOTTOM_MID, 0, -12);

    s_ota_view = lv_obj_create(scr);
    prepare_panel_obj(s_ota_view, DISPLAY_COLOR_BG);
    lv_obj_set_size(s_ota_view, DISPLAY_LOGICAL_W, DISPLAY_LOGICAL_H);

    s_ota_title = lv_label_create(s_ota_view);
    lv_label_set_text(s_ota_title, "FIRMWARE UPDATE");
    style_text(s_ota_title, DISPLAY_FONT_SM, DISPLAY_COLOR_ACCENT);
    lv_obj_set_style_text_letter_space(s_ota_title, 1, 0);
    lv_obj_align(s_ota_title, LV_ALIGN_TOP_MID, 0, 18);

    s_ota_percent = lv_label_create(s_ota_view);
    lv_label_set_text(s_ota_percent, "0%");
    style_text(s_ota_percent, DISPLAY_FONT_CLOCK, DISPLAY_COLOR_TEXT);
    lv_obj_align(s_ota_percent, LV_ALIGN_CENTER, 0, -18);

    s_ota_bar = lv_bar_create(s_ota_view);
    lv_obj_set_size(s_ota_bar, 176, 12);
    lv_obj_align(s_ota_bar, LV_ALIGN_CENTER, 0, 20);
    lv_bar_set_range(s_ota_bar, 0, 100);
    lv_bar_set_value(s_ota_bar, 0, LV_ANIM_OFF);
    lv_obj_set_style_radius(s_ota_bar, 6, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_ota_bar, lv_color_hex(DISPLAY_COLOR_DIVIDER), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_ota_bar, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_radius(s_ota_bar, 6, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(s_ota_bar, lv_color_hex(DISPLAY_COLOR_ACCENT), LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(s_ota_bar, LV_OPA_COVER, LV_PART_INDICATOR);

    s_ota_status = lv_label_create(s_ota_view);
    lv_obj_set_width(s_ota_status, DISPLAY_TEXT_W);
    lv_label_set_text(s_ota_status, "Preparing update");
    lv_label_set_long_mode(s_ota_status, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(s_ota_status, LV_TEXT_ALIGN_CENTER, 0);
    style_text(s_ota_status, DISPLAY_FONT_SM, DISPLAY_COLOR_TEXT);
    lv_obj_align(s_ota_status, LV_ALIGN_CENTER, 0, 48);

    s_ota_note = lv_label_create(s_ota_view);
    lv_obj_set_width(s_ota_note, DISPLAY_TEXT_W);
    lv_label_set_text(s_ota_note, "Do not power off");
    lv_label_set_long_mode(s_ota_note, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(s_ota_note, LV_TEXT_ALIGN_CENTER, 0);
    style_text(s_ota_note, DISPLAY_FONT_XS, DISPLAY_COLOR_MUTED);
    lv_obj_align(s_ota_note, LV_ALIGN_BOTTOM_MID, 0, -16);

    s_runtime_view = lv_obj_create(scr);
    prepare_panel_obj(s_runtime_view, DISPLAY_COLOR_BG);
    lv_obj_set_size(s_runtime_view, DISPLAY_LOGICAL_W, DISPLAY_LOGICAL_H);

    lv_obj_t *status_bar = lv_obj_create(s_runtime_view);
    prepare_panel_obj(status_bar, DISPLAY_COLOR_STATUS_BG);
    lv_obj_set_size(status_bar, DISPLAY_LOGICAL_W, DISPLAY_STATUSBAR_H);
    lv_obj_align(status_bar, LV_ALIGN_TOP_MID, 0, 0);
    lv_obj_set_style_border_side(status_bar, LV_BORDER_SIDE_BOTTOM, 0);
    lv_obj_set_style_border_width(status_bar, 1, 0);
    lv_obj_set_style_border_color(status_bar, lv_color_hex(DISPLAY_COLOR_DIVIDER), 0);
    lv_obj_set_style_pad_left(status_bar, 5, 0);
    lv_obj_set_style_pad_right(status_bar, 5, 0);
    lv_obj_set_layout(status_bar, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(status_bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(status_bar, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t *status_left = lv_obj_create(status_bar);
    prepare_panel_obj(status_left, DISPLAY_COLOR_STATUS_BG);
    lv_obj_set_size(status_left, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_layout(status_left, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(status_left, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(status_left, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(status_left, 3, 0);

    lv_obj_t *wifi_icon = lv_label_create(status_left);
    lv_label_set_text(wifi_icon, LV_SYMBOL_WIFI);
    style_text(wifi_icon, DISPLAY_FONT_XS, DISPLAY_COLOR_TEXT);

    s_status_ssid = lv_label_create(status_left);
    lv_label_set_text(s_status_ssid, "No Wi-Fi");
    style_text(s_status_ssid, DISPLAY_FONT_XS, DISPLAY_COLOR_TEXT);

    lv_obj_t *status_right = lv_obj_create(status_bar);
    prepare_panel_obj(status_right, DISPLAY_COLOR_STATUS_BG);
    lv_obj_set_size(status_right, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_layout(status_right, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(status_right, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(status_right, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(status_right, 4, 0);

    create_signal_bars(status_right);

    s_status_rssi = lv_label_create(status_right);
    lv_label_set_text(s_status_rssi, "-- dBm");
    style_text(s_status_rssi, DISPLAY_FONT_XS, DISPLAY_COLOR_MUTED);

    lv_obj_t *clock_wrap = lv_obj_create(s_runtime_view);
    prepare_panel_obj(clock_wrap, DISPLAY_COLOR_BG);
    lv_obj_set_size(clock_wrap, DISPLAY_LOGICAL_W, DISPLAY_CLOCK_H);
    lv_obj_align(clock_wrap, LV_ALIGN_TOP_MID, 0, DISPLAY_STATUSBAR_H);
    lv_obj_set_layout(clock_wrap, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(clock_wrap, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(clock_wrap, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    s_clock_hh = lv_label_create(clock_wrap);
    lv_label_set_text(s_clock_hh, "--");
    style_text(s_clock_hh, DISPLAY_FONT_CLOCK, DISPLAY_COLOR_TEXT);

    lv_obj_t *clock_colon_1 = lv_label_create(clock_wrap);
    lv_label_set_text(clock_colon_1, ":");
    style_text(clock_colon_1, DISPLAY_FONT_CLOCK, DISPLAY_COLOR_ACCENT);

    s_clock_mm = lv_label_create(clock_wrap);
    lv_label_set_text(s_clock_mm, "--");
    style_text(s_clock_mm, DISPLAY_FONT_CLOCK, DISPLAY_COLOR_TEXT);

    lv_obj_t *clock_colon_2 = lv_label_create(clock_wrap);
    lv_label_set_text(clock_colon_2, ":");
    style_text(clock_colon_2, DISPLAY_FONT_CLOCK, DISPLAY_COLOR_ACCENT);

    s_clock_ss = lv_label_create(clock_wrap);
    lv_label_set_text(s_clock_ss, "--");
    style_text(s_clock_ss, DISPLAY_FONT_CLOCK, DISPLAY_COLOR_ACCENT);

    lv_obj_t *date_row = lv_obj_create(s_runtime_view);
    prepare_panel_obj(date_row, DISPLAY_COLOR_BG);
    lv_obj_set_size(date_row, DISPLAY_LOGICAL_W, DISPLAY_DATE_ROW_H);
    lv_obj_align(date_row, LV_ALIGN_TOP_MID, 0, DISPLAY_STATUSBAR_H + DISPLAY_CLOCK_H);
    lv_obj_set_layout(date_row, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(date_row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(date_row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(date_row, 5, 0);

    s_date_dow = lv_label_create(date_row);
    lv_label_set_text(s_date_dow, "WAIT");
    style_text(s_date_dow, DISPLAY_FONT_XS, DISPLAY_COLOR_TEXT);
    lv_obj_set_style_text_letter_space(s_date_dow, 1, 0);

    lv_obj_t *date_dot = lv_label_create(date_row);
    lv_label_set_text(date_dot, LV_SYMBOL_BULLET);
    style_text(date_dot, DISPLAY_FONT_XS, DISPLAY_COLOR_FAINT);

    s_date_value = lv_label_create(date_row);
    lv_label_set_text(s_date_value, "Time sync");
    style_text(s_date_value, DISPLAY_FONT_XS, DISPLAY_COLOR_MUTED);

    lv_obj_t *sensor_row = lv_obj_create(s_runtime_view);
    prepare_panel_obj(sensor_row, DISPLAY_COLOR_BG);
    lv_obj_set_size(sensor_row, DISPLAY_LOGICAL_W, DISPLAY_SENSORS_H);
    lv_obj_align(sensor_row, LV_ALIGN_BOTTOM_MID, 0, 0);
    lv_obj_set_style_border_side(sensor_row, LV_BORDER_SIDE_TOP, 0);
    lv_obj_set_style_border_width(sensor_row, 1, 0);
    lv_obj_set_style_border_color(sensor_row, lv_color_hex(DISPLAY_COLOR_DIVIDER), 0);
    lv_obj_set_layout(sensor_row, LV_LAYOUT_FLEX);
    lv_obj_set_flex_flow(sensor_row, LV_FLEX_FLOW_ROW);
    lv_obj_set_style_pad_all(sensor_row, 0, 0);

    for (size_t i = 0; i < DISPLAY_SIGNAL_BAR_COUNT; i++) {
        create_sensor_cell(sensor_row, i);
    }

    lv_obj_t *status_version = lv_label_create(s_runtime_view);
    lv_obj_set_width(status_version, DISPLAY_VERSION_W);
    lv_label_set_long_mode(status_version, LV_LABEL_LONG_DOT);
    lv_label_set_text_fmt(status_version, "%s", FIRMWARE_VERSION);
    lv_obj_set_style_text_align(status_version, LV_TEXT_ALIGN_LEFT, 0);
    style_text(status_version, DISPLAY_FONT_XS, DISPLAY_COLOR_MUTED);
    lv_obj_align(status_version, LV_ALIGN_TOP_LEFT, 5, DISPLAY_STATUSBAR_H + 1);

    set_hidden(s_ota_view, true);
}

#if SA_DISP_SELF_TEST
static void set_centered_label_style(lv_obj_t *label)
{
    lv_obj_set_width(label, DISPLAY_TEXT_W);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
}

static void self_test_wait(uint32_t duration_ms)
{
    uint32_t elapsed_ms = 0;
    while (elapsed_ms < duration_ms) {
        lv_timer_handler();

        uint32_t step_ms = DISPLAY_SELF_TEST_TICK_MS;
        uint32_t remaining_ms = duration_ms - elapsed_ms;
        if (remaining_ms < step_ms) {
            step_ms = remaining_ms;
        }

        vTaskDelay(pdMS_TO_TICKS(step_ms));
        elapsed_ms += step_ms;
    }
}

static void self_test_fullscreen(uint32_t bg_hex, uint32_t fg_hex, const char *title, const char *footer)
{
    lv_obj_t *scr = lv_scr_act();
    lv_obj_clean(scr);
    prepare_screen(scr, bg_hex);

    lv_obj_t *title_label = lv_label_create(scr);
    set_centered_label_style(title_label);
    lv_obj_set_style_text_color(title_label, lv_color_hex(fg_hex), 0);
    lv_label_set_text(title_label, title);
    lv_obj_align(title_label, LV_ALIGN_CENTER, 0, -8);

    lv_obj_t *footer_label = lv_label_create(scr);
    set_centered_label_style(footer_label);
    lv_obj_set_style_text_color(footer_label, lv_color_hex(fg_hex), 0);
    lv_label_set_text(footer_label, footer);
    lv_obj_align(footer_label, LV_ALIGN_CENTER, 0, 22);

    lv_timer_handler();
    self_test_wait(SA_DISP_SELF_TEST_HOLD_MS);
}

static void self_test_corner_box(
    lv_obj_t *parent, lv_align_t align, lv_coord_t x_ofs, lv_coord_t y_ofs, uint32_t bg_hex, const char *text)
{
    lv_obj_t *box = lv_obj_create(parent);
    lv_obj_remove_style_all(box);
    lv_obj_set_size(box, 40, 28);
    lv_obj_set_style_bg_color(box, lv_color_hex(bg_hex), 0);
    lv_obj_set_style_bg_opa(box, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(box, 4, 0);
    lv_obj_align(box, align, x_ofs, y_ofs);

    lv_obj_t *label = lv_label_create(box);
    lv_obj_set_style_text_color(label, lv_color_hex(0xFFFFFF), 0);
    lv_label_set_text(label, text);
    lv_obj_center(label);
}

static void self_test_orientation(void)
{
    lv_obj_t *scr = lv_scr_act();
    lv_obj_clean(scr);
    prepare_screen(scr, 0xFFFFFF);

    lv_obj_t *title_label = lv_label_create(scr);
    set_centered_label_style(title_label);
    lv_label_set_text(title_label, "Orientation test");
    lv_obj_align(title_label, LV_ALIGN_TOP_MID, 0, 12);

    self_test_corner_box(scr, LV_ALIGN_TOP_LEFT, 8, 42, 0xD32F2F, "TL");
    self_test_corner_box(scr, LV_ALIGN_TOP_RIGHT, -8, 42, 0x1976D2, "TR");
    self_test_corner_box(scr, LV_ALIGN_BOTTOM_LEFT, 8, -42, 0x388E3C, "BL");
    self_test_corner_box(scr, LV_ALIGN_BOTTOM_RIGHT, -8, -42, 0xF57C00, "BR");

    lv_obj_t *note_label = lv_label_create(scr);
    set_centered_label_style(note_label);
    lv_label_set_text(note_label, "Check corner labels and color order");
    lv_obj_align(note_label, LV_ALIGN_CENTER, 0, 0);

    lv_timer_handler();
    self_test_wait(SA_DISP_SELF_TEST_HOLD_MS);
}

static void run_self_test(void)
{
    ESP_LOGI(TAG, "running display self-test");
    self_test_fullscreen(0xD32F2F, 0xFFFFFF, "DISPLAY TEST", "RED");
    self_test_fullscreen(0x388E3C, 0xFFFFFF, "DISPLAY TEST", "GREEN");
    self_test_fullscreen(0x1976D2, 0xFFFFFF, "DISPLAY TEST", "BLUE");
    self_test_orientation();
    lv_obj_clean(lv_scr_act());
}
#endif

static void render_boot_phase(display_boot_phase_t phase)
{
    if (s_boot_logo == NULL || s_boot_status == NULL) {
        return;
    }

    set_hidden(s_boot_view, false);
    set_hidden(s_ota_view, true);
    set_hidden(s_runtime_view, true);

    const char *status = "Booting";

    switch (phase) {
    case DISPLAY_BOOT_PHASE_BOOT:
        status = "Starting system";
        break;
    case DISPLAY_BOOT_PHASE_BLE:
        status = "Waiting for Wi-Fi setup";
        break;
    case DISPLAY_BOOT_PHASE_WIFI:
        status = "Connecting to network";
        break;
    case DISPLAY_BOOT_PHASE_WAITING_CONFIG:
        status = "Waiting for cloud secret";
        break;
    case DISPLAY_BOOT_PHASE_MQTT:
        status = "Connecting MQTT";
        break;
    case DISPLAY_BOOT_PHASE_READY:
        status = "System online";
        break;
    default:
        break;
    }

    lv_label_set_text(s_boot_status, status);
}

static const char *ota_base_status(display_ota_stage_t stage)
{
    switch (stage) {
    case DISPLAY_OTA_STAGE_STARTING:
        return "Preparing update";
    case DISPLAY_OTA_STAGE_DOWNLOADING:
        return "Downloading firmware";
    case DISPLAY_OTA_STAGE_VERIFYING:
        return "Verifying package";
    case DISPLAY_OTA_STAGE_REBOOTING:
        return "Rebooting";
    case DISPLAY_OTA_STAGE_FAILED:
        return "Update failed";
    case DISPLAY_OTA_STAGE_IDLE:
    default:
        return "Preparing update";
    }
}

static const char *ota_error_text(display_ota_error_t error)
{
    switch (error) {
    case DISPLAY_OTA_ERROR_SHA256_MISMATCH:
        return "Checksum mismatch";
    case DISPLAY_OTA_ERROR_BUSY:
        return "Update already in progress";
    case DISPLAY_OTA_ERROR_GENERIC:
        return "Download failed";
    case DISPLAY_OTA_ERROR_NONE:
    default:
        return "Update failed";
    }
}

static void append_status_dots(char *buf, size_t buf_len, int64_t now_us)
{
    size_t used = strlen(buf);
    if (used + 4U >= buf_len) {
        return;
    }

    size_t dot_count = (size_t)((now_us / DISPLAY_OTA_DOT_STEP_US) % 4);
    for (size_t i = 0; i < dot_count; i++) {
        buf[used++] = '.';
    }
    buf[used] = '\0';
}

static void render_ota(const display_state_t *state, int64_t now_us)
{
    if (state == NULL || s_ota_view == NULL) {
        return;
    }

    const display_ota_runtime_t *ota = &state->ota;
    if (!ota->state.active) {
        return;
    }

    prepare_screen(lv_scr_act(), DISPLAY_COLOR_BG);
    set_hidden(s_boot_view, true);
    set_hidden(s_ota_view, false);
    set_hidden(s_runtime_view, true);

    uint32_t accent = DISPLAY_COLOR_ACCENT;
    uint32_t note_color = DISPLAY_COLOR_MUTED;
    const char *note = "Do not power off";
    if (ota->state.stage == DISPLAY_OTA_STAGE_FAILED) {
        accent = DISPLAY_COLOR_DANGER;
        note_color = DISPLAY_COLOR_DANGER;
        note = ota_error_text(ota->state.error);
    } else if (ota->state.error == DISPLAY_OTA_ERROR_BUSY) {
        note_color = DISPLAY_COLOR_WARNING;
        note = ota_error_text(ota->state.error);
    }

    char percent_buf[8];
    snprintf(percent_buf, sizeof(percent_buf), "%u%%", (unsigned)ota->state.percent);
    lv_label_set_text(s_ota_percent, percent_buf);
    lv_bar_set_value(s_ota_bar, ota->state.percent, LV_ANIM_OFF);

    char status_buf[32];
    snprintf(status_buf, sizeof(status_buf), "%s", ota_base_status(ota->state.stage));
    if (ota->state.stage == DISPLAY_OTA_STAGE_STARTING || ota->state.stage == DISPLAY_OTA_STAGE_DOWNLOADING ||
        ota->state.stage == DISPLAY_OTA_STAGE_VERIFYING) {
        append_status_dots(status_buf, sizeof(status_buf), now_us);
    } else if (ota->state.stage == DISPLAY_OTA_STAGE_REBOOTING) {
        strlcpy(status_buf, "Rebooting...", sizeof(status_buf));
    }
    lv_label_set_text(s_ota_status, status_buf);
    lv_label_set_text(s_ota_note, note);

    style_text(s_ota_title, DISPLAY_FONT_SM, accent);
    style_text(s_ota_percent, DISPLAY_FONT_CLOCK, accent);
    lv_obj_set_style_bg_color(s_ota_bar, lv_color_hex(DISPLAY_COLOR_DIVIDER), LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_ota_bar, lv_color_hex(accent), LV_PART_INDICATOR);
    style_text(s_ota_status, DISPLAY_FONT_SM, DISPLAY_COLOR_TEXT);
    style_text(s_ota_note, DISPLAY_FONT_XS, note_color);
}

static uint8_t signal_level_from_rssi(int rssi_dbm)
{
    if (rssi_dbm >= -55) {
        return 4;
    }
    if (rssi_dbm >= -67) {
        return 3;
    }
    if (rssi_dbm >= -75) {
        return 2;
    }
    if (rssi_dbm >= -85) {
        return 1;
    }
    return 0;
}

static void set_signal_bars(bool wifi_connected, bool have_rssi, int rssi_dbm)
{
    uint8_t level = 0;
    if (wifi_connected && have_rssi) {
        level = signal_level_from_rssi(rssi_dbm);
    }

    for (size_t i = 0; i < DISPLAY_SIGNAL_BAR_COUNT; i++) {
        uint32_t color = (wifi_connected && i < level) ? DISPLAY_COLOR_TEXT : DISPLAY_COLOR_FAINT;
        lv_obj_set_style_bg_color(s_signal_bars[i], lv_color_hex(color), 0);
    }
}

static void format_sensor_value(char *value_buf, size_t value_len, float value)
{
    snprintf(value_buf, value_len, "%.2f", (double)value);
}

static void set_sensor_cell(size_t index, const char *value, const char *sub, uint32_t value_color)
{
    if (index >= DISPLAY_SIGNAL_BAR_COUNT) {
        return;
    }

    lv_label_set_text(s_sensor_cells[index].value, value);
    lv_label_set_text(s_sensor_cells[index].sub, sub);
    lv_obj_set_style_text_color(s_sensor_cells[index].value, lv_color_hex(value_color), 0);
}

static void render_runtime(const display_state_t *state, time_t now, bool wifi_connected, bool have_rssi, int rssi_dbm)
{
    if (state == NULL || s_runtime_view == NULL) {
        return;
    }

    if (state->mode_known && !state->mode_on) {
        prepare_screen(lv_scr_act(), 0x000000);
        set_hidden(s_boot_view, true);
        set_hidden(s_ota_view, true);
        set_hidden(s_runtime_view, true);
        return;
    }

    prepare_screen(lv_scr_act(), DISPLAY_COLOR_BG);
    set_hidden(s_boot_view, true);
    set_hidden(s_ota_view, true);
    set_hidden(s_runtime_view, false);

    char ssid_buf[33] = "No Wi-Fi";
    if (wifi_connected) {
        if (wifi_sta_get_ssid(ssid_buf, sizeof(ssid_buf)) != ESP_OK || ssid_buf[0] == '\0') {
            strlcpy(ssid_buf, "Wi-Fi", sizeof(ssid_buf));
        }
    }

    char rssi_buf[20] = "-- dBm";
    if (wifi_connected && have_rssi) {
        snprintf(rssi_buf, sizeof(rssi_buf), "%d dBm", rssi_dbm);
    } else if (!wifi_connected) {
        strlcpy(rssi_buf, "offline", sizeof(rssi_buf));
    }
    lv_label_set_text(s_status_ssid, ssid_buf);
    lv_label_set_text(s_status_rssi, rssi_buf);
    set_signal_bars(wifi_connected, have_rssi, rssi_dbm);

    if (now >= (time_t)DISPLAY_MIN_VALID_UNIX_TS) {
        struct tm tm_now = {0};
        static const char *const weekdays[] = {
            "SUNDAY",
            "MONDAY",
            "TUESDAY",
            "WEDNESDAY",
            "THURSDAY",
            "FRIDAY",
            "SATURDAY",
        };
        static const char *const months[] = {
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
        };

        localtime_r(&now, &tm_now);

        char hh_buf[3];
        char mm_buf[3];
        char ss_buf[3];
        snprintf(hh_buf, sizeof(hh_buf), "%02d", tm_now.tm_hour);
        snprintf(mm_buf, sizeof(mm_buf), "%02d", tm_now.tm_min);
        snprintf(ss_buf, sizeof(ss_buf), "%02d", tm_now.tm_sec);
        lv_label_set_text(s_clock_hh, hh_buf);
        lv_label_set_text(s_clock_mm, mm_buf);
        lv_label_set_text(s_clock_ss, ss_buf);

        char date_buf[24];
        snprintf(date_buf, sizeof(date_buf), "%d %s %d", tm_now.tm_mday, months[tm_now.tm_mon], tm_now.tm_year + 1900);
        lv_label_set_text(s_date_dow, weekdays[tm_now.tm_wday]);
        lv_label_set_text(s_date_value, date_buf);
    } else {
        lv_label_set_text(s_clock_hh, "--");
        lv_label_set_text(s_clock_mm, "--");
        lv_label_set_text(s_clock_ss, "--");
        lv_label_set_text(s_date_dow, "WAIT");
        lv_label_set_text(s_date_value, "Time sync");
    }

    char value_buf[24];
    if (state->sensor.have_temperature_humidity) {
        format_sensor_value(value_buf, sizeof(value_buf), state->sensor.temperature_c);
        set_sensor_cell(0, value_buf, "C", SENSOR_ACCENT_COLORS[0]);

        format_sensor_value(value_buf, sizeof(value_buf), state->sensor.humidity_pct);
        set_sensor_cell(1, value_buf, "%RH", SENSOR_ACCENT_COLORS[1]);
    } else {
        set_sensor_cell(0, "--", "C", SENSOR_ACCENT_COLORS[0]);
        set_sensor_cell(1, "--", "%RH", SENSOR_ACCENT_COLORS[1]);
    }

    if (state->sensor.have_co) {
        format_sensor_value(value_buf, sizeof(value_buf), state->sensor.co_ppm);
        set_sensor_cell(2, value_buf, "ppm", SENSOR_ACCENT_COLORS[2]);
    } else {
        set_sensor_cell(2, "--", "ppm", SENSOR_ACCENT_COLORS[2]);
    }

    if (state->sensor.have_no2) {
        format_sensor_value(value_buf, sizeof(value_buf), state->sensor.no2_ppm);
        set_sensor_cell(3, value_buf, "ppm", SENSOR_ACCENT_COLORS[3]);
    } else {
        set_sensor_cell(3, "--", "ppm", SENSOR_ACCENT_COLORS[3]);
    }
}

static void render_screen(void)
{
    int64_t now_us = esp_timer_get_time();
    refresh_ota_state(now_us);

    display_state_t state;
    snapshot_state(&state);

    time_t now = time(NULL);
    bool wifi_connected = wifi_sta_is_connected();
    bool have_rssi = false;
    int rssi_dbm = 0;
    if (wifi_connected && wifi_sta_get_rssi(&rssi_dbm) == ESP_OK) {
        have_rssi = true;
    }

    if (state.ota.state.active) {
        render_ota(&state, now_us);
        return;
    }

    if (state.phase == DISPLAY_BOOT_PHASE_READY) {
        render_runtime(&state, now, wifi_connected, have_rssi, rssi_dbm);
        return;
    }

    render_boot_phase(state.phase);
}

static void display_flush(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *color_p)
{
    const size_t pixel_count = lv_area_get_size(area);
    const size_t byte_count = pixel_count * sizeof(lv_color_t);
    const uint8_t *tx = (const uint8_t *)color_p;

#if !defined(CONFIG_LV_COLOR_16_SWAP) || !CONFIG_LV_COLOR_16_SWAP
    for (size_t i = 0; i < pixel_count; i++) {
        const uint8_t *src = (const uint8_t *)&color_p[i];
        s_swap_buf[(i * 2U)] = src[1];
        s_swap_buf[(i * 2U) + 1U] = src[0];
    }
    tx = s_swap_buf;
#endif

    esp_err_t err = ili9225_write_area(
        (uint16_t)area->x1, (uint16_t)area->y1, (uint16_t)area->x2, (uint16_t)area->y2, tx, byte_count);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ili9225_write_area failed (%s)", esp_err_to_name(err));
    }

    lv_disp_flush_ready(drv);
}

static esp_err_t init_runtime(void)
{
    ili9225_cfg_t cfg = {
        .host = SPI2_HOST,
        .pin_clk = SA_DISP_CLK_PIN,
        .pin_mosi = SA_DISP_SDA_PIN,
        .pin_dc = SA_DISP_RS_PIN,
        .pin_rst = SA_DISP_RST_PIN,
        .pin_cs = SA_DISP_CS_PIN,
        .clock_speed_hz = SA_DISP_SPI_HZ,
    };

    esp_err_t err = ili9225_init(&cfg);
    if (err != ESP_OK) {
        return err;
    }

    lv_init();

    s_buf1 = heap_caps_malloc(DISPLAY_BUF_PIXELS * sizeof(lv_color_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    s_buf2 = heap_caps_malloc(DISPLAY_BUF_PIXELS * sizeof(lv_color_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    s_swap_buf = heap_caps_malloc(DISPLAY_BUF_PIXELS * sizeof(lv_color_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (s_buf1 == NULL || s_buf2 == NULL || s_swap_buf == NULL) {
        return ESP_ERR_NO_MEM;
    }

    lv_disp_draw_buf_init(&s_draw_buf, s_buf1, s_buf2, DISPLAY_BUF_PIXELS);

    static lv_disp_drv_t disp_drv;
    lv_disp_drv_init(&disp_drv);
    /* With sw_rotate enabled, LVGL expects the driver to advertise the
     * panel's native resolution and handles the logical 220x176 landscape
     * view through rotation internally. */
    disp_drv.hor_res = DISPLAY_NATIVE_W;
    disp_drv.ver_res = DISPLAY_NATIVE_H;
    disp_drv.flush_cb = display_flush;
    disp_drv.draw_buf = &s_draw_buf;
    disp_drv.rotated = LV_DISP_ROT_270;
    disp_drv.sw_rotate = 1;
    lv_disp_drv_register(&disp_drv);

    const esp_timer_create_args_t timer_args = {
        .callback = lv_tick_cb,
        .name = "display_tick",
    };
    err = esp_timer_create(&timer_args, &s_tick_timer);
    if (err != ESP_OK) {
        return err;
    }
    err = esp_timer_start_periodic(s_tick_timer, DISPLAY_TICK_MS * 1000ULL);
    if (err != ESP_OK) {
        return err;
    }

#if SA_DISP_SELF_TEST
    run_self_test();
#endif
    build_screen();
    render_screen();
    s_ready = true;
    return ESP_OK;
}

static void display_task(void *arg)
{
    (void)arg;

    s_init_result = init_runtime();
    if (s_init_done != NULL) {
        xSemaphoreGive(s_init_done);
    }
    if (s_init_result != ESP_OK) {
        vTaskDelete(NULL);
    }

    TickType_t last_render = 0;
    while (true) {
        lv_timer_handler();

        TickType_t now = xTaskGetTickCount();
        if ((now - last_render) >= pdMS_TO_TICKS(DISPLAY_UI_REFRESH_MS)) {
            render_screen();
            last_render = now;
        }

        vTaskDelay(pdMS_TO_TICKS(DISPLAY_TASK_DELAY_MS));
    }
}

static TickType_t init_wait_ticks(void)
{
    uint32_t wait_ms = DISPLAY_INIT_WAIT_BASE_MS;

#if SA_DISP_SELF_TEST
    wait_ms += (SA_DISP_SELF_TEST_HOLD_MS * DISPLAY_SELF_TEST_SCREEN_COUNT);
#endif
    wait_ms += DISPLAY_INIT_WAIT_MARGIN_MS;

    return pdMS_TO_TICKS(wait_ms);
}

static void cleanup_failed_init(void)
{
    s_ready = false;

    if (s_tick_timer != NULL) {
        esp_timer_stop(s_tick_timer);
        esp_timer_delete(s_tick_timer);
        s_tick_timer = NULL;
    }

    if (s_buf1 != NULL) {
        free(s_buf1);
        s_buf1 = NULL;
    }
    if (s_buf2 != NULL) {
        free(s_buf2);
        s_buf2 = NULL;
    }
    if (s_swap_buf != NULL) {
        free(s_swap_buf);
        s_swap_buf = NULL;
    }
    if (s_init_done != NULL) {
        vSemaphoreDelete(s_init_done);
        s_init_done = NULL;
    }
    s_task = NULL;
}

#endif

esp_err_t display_service_init(void)
{
#if SA_ENABLE_ILI9225
    if (s_ready) {
        return ESP_OK;
    }
    if (s_task != NULL) {
        return s_init_result;
    }

    s_init_done = xSemaphoreCreateBinary();
    if (s_init_done == NULL) {
        cleanup_failed_init();
        return ESP_ERR_NO_MEM;
    }

    BaseType_t rc = xTaskCreatePinnedToCore(display_task, "display_service", 8192, NULL, 5, &s_task, tskNO_AFFINITY);
    if (rc != pdPASS) {
        cleanup_failed_init();
        return ESP_ERR_NO_MEM;
    }

    if (xSemaphoreTake(s_init_done, init_wait_ticks()) != pdTRUE) {
        cleanup_failed_init();
        return ESP_ERR_TIMEOUT;
    }
    vSemaphoreDelete(s_init_done);
    s_init_done = NULL;

    if (s_init_result != ESP_OK) {
        cleanup_failed_init();
        return s_init_result;
    }

    ESP_LOGI(TAG, "init OK");
    return ESP_OK;
#else
    return ESP_OK;
#endif
}

bool display_service_is_ready(void)
{
#if SA_ENABLE_ILI9225
    return s_ready;
#else
    return false;
#endif
}

void display_service_set_boot_phase(display_boot_phase_t phase)
{
#if SA_ENABLE_ILI9225
    portENTER_CRITICAL(&s_state_lock);
    s_state.phase = phase;
    portEXIT_CRITICAL(&s_state_lock);
#else
    (void)phase;
#endif
}

void display_service_set_mode(bool on)
{
#if SA_ENABLE_ILI9225
    portENTER_CRITICAL(&s_state_lock);
    s_state.mode_known = true;
    s_state.mode_on = on;
    portEXIT_CRITICAL(&s_state_lock);
#else
    (void)on;
#endif
}

void display_service_set_relay_states(const bool relay_states[3])
{
#if SA_ENABLE_ILI9225
    if (relay_states == NULL) {
        return;
    }

    portENTER_CRITICAL(&s_state_lock);
    for (size_t i = 0; i < DISPLAY_RELAY_COUNT; i++) {
        s_state.relay_states[i] = relay_states[i];
    }
    portEXIT_CRITICAL(&s_state_lock);
#else
    (void)relay_states;
#endif
}

void display_service_set_sensor_snapshot(const display_sensor_snapshot_t *snapshot)
{
#if SA_ENABLE_ILI9225
    if (snapshot == NULL) {
        return;
    }

    portENTER_CRITICAL(&s_state_lock);
    s_state.sensor = *snapshot;
    portEXIT_CRITICAL(&s_state_lock);
#else
    (void)snapshot;
#endif
}

void display_service_set_ota_state(const display_ota_state_t *state)
{
#if SA_ENABLE_ILI9225
    if (state == NULL) {
        return;
    }

    portENTER_CRITICAL(&s_state_lock);
    display_ota_runtime_t *ota = &s_state.ota;
    if (!state->active) {
        clear_ota_runtime(ota);
        portEXIT_CRITICAL(&s_state_lock);
        return;
    }

    if (state->error == DISPLAY_OTA_ERROR_BUSY && ota->state.active && ota->state.stage != DISPLAY_OTA_STAGE_FAILED) {
        ota->state.error = DISPLAY_OTA_ERROR_BUSY;
        ota->message_deadline_us = esp_timer_get_time() + DISPLAY_OTA_HOLD_US;
        portEXIT_CRITICAL(&s_state_lock);
        return;
    }

    ota->state = *state;
    if (ota->state.stage == DISPLAY_OTA_STAGE_FAILED) {
        ota->message_deadline_us = esp_timer_get_time() + DISPLAY_OTA_HOLD_US;
    } else if (ota->state.error == DISPLAY_OTA_ERROR_BUSY) {
        ota->message_deadline_us = esp_timer_get_time() + DISPLAY_OTA_HOLD_US;
    } else {
        ota->message_deadline_us = 0;
        ota->state.error = DISPLAY_OTA_ERROR_NONE;
    }
    portEXIT_CRITICAL(&s_state_lock);
#else
    (void)state;
#endif
}
