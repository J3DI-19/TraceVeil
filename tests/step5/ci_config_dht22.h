// Compile-only values; never flash this configuration onto a real device.
#pragma once
#define TV_WIFI_SSID "ci-noop"
#define TV_WIFI_PSK "ci-noop"
#define TV_CASE_ID 1
#define TV_SOURCE_ID "esp32-ci-dht22"
#define TV_DEVICE_ID "esp32-ci-dht22"
#define TV_SOURCE_TOKEN "ci-noop"
#define TV_HTTP_HOST "traceveil.lab"
#define TV_HTTP_PORT 8443
#define TV_HTTP_PATH "/api/v1/live/telemetry"
static const char TV_HTTP_ROOT_CA_PEM[] = "ci-only-ca-material";
#define TV_NTP_SERVER "127.0.0.1"
#define TV_NTP_MIN_EPOCH 1735689600UL
#define TV_NTP_TIMEOUT_MS 1000UL
#define TV_PIN_DHT 4
#define TV_SAMPLE_INTERVAL_MS 3000UL
#define TV_RETRY_INTERVAL_MS 5000UL
