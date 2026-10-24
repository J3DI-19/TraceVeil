// First hardware check: no Wi-Fi, token, case, or backend required.
// Three-pin DHT22 module: + -> 3V3, - -> GND, OUT -> GPIO 4.
#include <Arduino.h>
#include <DHT.h>

static DHT sensor(4, DHT22);

void setup() {
  Serial.begin(115200);
  sensor.begin();
  delay(2000); // Let the sensor stabilize after power-up.
  Serial.println("Traceveil DHT22 USB test: OUT must connect to GPIO 4");
}

void loop() {
  const float temperature = sensor.readTemperature();
  const float humidity = sensor.readHumidity();
  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("Read failed: unplug USB, check +/3V3, -/GND, OUT/GPIO4 and sensor type.");
  } else {
    Serial.printf("Temperature: %.2f C | Humidity: %.2f %%\n", temperature, humidity);
  }
  delay(3000);
}
