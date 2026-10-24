// USB capture for the classic ESP32 + DHT22 module (OUT on GPIO 4).
// No Wi-Fi credentials, case identifiers or network clock are required.
#include <Arduino.h>
#include <DHT.h>
#include <Preferences.h>
#include <math.h>

static DHT sensor(4, DHT22);
static Preferences nvs;
static uint32_t sequence_number;
static bool capturing = false;
static bool storage_ready = false;
static unsigned long last_sample;
static String command;

static void hello() {
  Serial.println("{\"protocol\":\"traceveil-usb-v1\",\"type\":\"hello\",\"sensor\":\"DHT22\",\"pin\":4}");
}

void setup() {
  Serial.begin(115200);
  sensor.begin();
  storage_ready = nvs.begin("traceveil", false);
  sequence_number = storage_ready ? nvs.getUInt("seq", 0) : 0;
  last_sample = millis();
  hello();
}

void loop() {
  while (Serial.available()) {
    const char ch = Serial.read();
    if (ch == '\n') {
      command.trim();
      if (command == "HELLO") hello();
      if (command == "START") { capturing = true; hello(); }
      if (command == "STOP") capturing = false;
      command = "";
    } else if (command.length() < 32) command += ch;
    else command = "";
  }
  if (capturing && millis() - last_sample >= 3000UL) {
    last_sample = millis();
    const float temperature = sensor.readTemperature();
    const float humidity = sensor.readHumidity();
    if (!storage_ready || sequence_number == UINT32_MAX) {
      Serial.println("{\"type\":\"error\",\"code\":\"sequence_storage_failed\"}");
      capturing = false;
    } else if (!isfinite(temperature) || !isfinite(humidity)) {
      Serial.println("{\"type\":\"error\",\"code\":\"dht_read_failed\"}");
    } else {
      ++sequence_number;
      if (!nvs.putUInt("seq", sequence_number)) {
        Serial.println("{\"type\":\"error\",\"code\":\"sequence_storage_failed\"}");
        capturing = false;
      } else {
        Serial.printf("{\"protocol\":\"traceveil-usb-v1\",\"type\":\"sample\",\"sequence\":%lu,\"temperature_c\":%.2f,\"humidity_pct\":%.2f,\"uptime_ms\":%lu}\n",
                      (unsigned long)sequence_number, temperature, humidity, millis());
      }
    }
  }
  delay(10);
}
