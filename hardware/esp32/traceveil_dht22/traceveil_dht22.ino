// Minimal physical capture: one ESP32, one DHT22, direct HTTPS to Traceveil.
// No PIR, relay, battery estimate, MQTT broker, or fabricated measurements.
#include "config.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <math.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

static DHT sensor(TV_PIN_DHT, DHT22);
static Preferences nvs;
static uint32_t sequence_number = 0;
static String pending_body;
static unsigned long last_sample_ms = 0;
static unsigned long last_attempt_ms = 0;

static void halt(const char* reason) {
  Serial.printf("HALT: %s\n", reason);
  while (true) delay(1000);
}

static bool connect_wifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.mode(WIFI_STA);
  WiFi.begin(TV_WIFI_SSID, TV_WIFI_PSK);
  const unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 15000UL) delay(200);
  return WiFi.status() == WL_CONNECTED;
}

static void synchronize_clock() {
  configTime(0, 0, TV_NTP_SERVER);
  const unsigned long started = millis();
  while (millis() - started < TV_NTP_TIMEOUT_MS) {
    if ((unsigned long)time(nullptr) >= TV_NTP_MIN_EPOCH) return;
    delay(200);
  }
  halt("NTP unavailable; cannot timestamp evidence");
}

static String observed_at_utc() {
  struct timeval now;
  gettimeofday(&now, nullptr);
  struct tm utc;
  gmtime_r(&now.tv_sec, &utc);
  char stamp[40];
  snprintf(stamp, sizeof(stamp), "%04d-%02d-%02dT%02d:%02d:%02d.%03d+00:00",
           utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday,
           utc.tm_hour, utc.tm_min, utc.tm_sec, (int)(now.tv_usec / 1000));
  return String(stamp);
}

static bool post_pending() {
  if (!connect_wifi()) {
    Serial.println("Wi-Fi unavailable; retaining frame in RAM");
    return false;
  }
  WiFiClientSecure client;
  client.setCACert(TV_HTTP_ROOT_CA_PEM);
  HTTPClient http;
  const String url = String("https://") + TV_HTTP_HOST + ":" + TV_HTTP_PORT + TV_HTTP_PATH;
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Traceveil-Source-Token", TV_SOURCE_TOKEN);
  const int status = http.POST((uint8_t*)pending_body.c_str(), pending_body.length());
  http.end();
  if (status == 202) {
    Serial.printf("accepted sequence=%lu\n", (unsigned long)sequence_number);
    return true;
  }
  Serial.printf("ingest failed status=%d; retrying same frame\n", status);
  return false;
}

static void sample() {
  const float temperature = sensor.readTemperature();
  const float humidity = sensor.readHumidity();
  if (!isfinite(temperature) || !isfinite(humidity)) {
    Serial.println("DHT22 read failed; no frame created");
    return;
  }

  // Persist before transmission so reboot cannot reuse a prior sequence.
  ++sequence_number;
  if (nvs.putUInt("seq", sequence_number) == 0) halt("cannot persist sequence");

  StaticJsonDocument<512> frame;
  frame["schema_version"] = "1.0";
  frame["case_id"] = TV_CASE_ID;
  frame["source_id"] = TV_SOURCE_ID;
  frame["device_id"] = TV_DEVICE_ID;
  frame["event_type"] = "telemetry";
  frame["observed_at"] = observed_at_utc();
  frame["sequence"] = sequence_number;
  JsonObject metrics = frame.createNestedObject("metrics");
  metrics["temperature_c"] = temperature;
  metrics["humidity_pct"] = humidity;
  pending_body = String();
  serializeJson(frame, pending_body);
  Serial.printf("sample sequence=%lu temperature=%.1f C humidity=%.1f %%\n",
                (unsigned long)sequence_number, temperature, humidity);
}

void setup() {
  Serial.begin(115200);
  sensor.begin();
  if (TV_CASE_ID < 1 || strlen(TV_SOURCE_ID) == 0 ||
      strstr(TV_SOURCE_TOKEN, "replace-with") != nullptr ||
      strlen(TV_HTTP_ROOT_CA_PEM) < 64 ||
      strstr(TV_HTTP_ROOT_CA_PEM, "REPLACE-WITH") != nullptr) {
    halt("set case, source token and HTTPS CA in config.h");
  }
  if (!nvs.begin("traceveil", false)) halt("cannot open NVS");
  sequence_number = nvs.getUInt("seq", 0);
  if (!connect_wifi()) halt("Wi-Fi unavailable at boot");
  synchronize_clock();
  Serial.println("DHT22 capture ready");
  last_sample_ms = millis() - TV_SAMPLE_INTERVAL_MS; // first reading immediately
}

void loop() {
  const unsigned long now = millis();
  if (pending_body.length()) {
    if (now - last_attempt_ms >= TV_RETRY_INTERVAL_MS) {
      last_attempt_ms = now;
      if (post_pending()) pending_body = String();
    }
  } else if (now - last_sample_ms >= TV_SAMPLE_INTERVAL_MS) {
    last_sample_ms = now;
    sample();
    if (pending_body.length()) {
      last_attempt_ms = millis();
      if (post_pending()) pending_body = String();
    }
  }
  delay(20);
}
