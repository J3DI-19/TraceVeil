# USB sensor testing

1. If Traceveil is closed, double-click **Start Sensor.cmd** in the project folder.
2. Connect the ESP32 using its micro-USB data cable.
3. In **Live Monitor → USB sensor setup**, keep **Create a new case** selected,
   or choose an existing case. Click **Connect & start**.

The local backend detects the CP2102 board, checks the firmware, installs the
USB sketch on first use, creates or selects the case, starts capture, and waits
for a real sensor reading to be saved before reporting success. The monitor
switches to that case. Repeated clicks during setup reuse the same operation.

This prepared installation uses the classic ESP32 target, DHT22 on GPIO 4,
the existing local `esp32-lab-01` source credential, and the compiler/libraries
in `.runtime/arduino`. USB firmware uses no Wi-Fi or network credentials and
does not depend on a hotspot, NTP, Caddy, a certificate or the laptop's IP.
The first installation replaces the board's current sketch with USB firmware;
subsequent starts only connect to it. Sequence numbers remain in ESP32 NVS.

Readings go through the same validation, durable receipts, normalization,
analysis, alerts and case storage as network telemetry. Temperature and
humidity come from the sensor. The laptop timestamps receipt in UTC; each
raw record identifies `timestamp_source=host_received_utc` and
`capture_transport=usb`. The board has no independently synchronized clock
in this mode. Keep the laptop clock correct.

Selecting another case ends this source's prior active capture. Existing
evidence is retained. **Stop USB capture**, the normal **Stop capture** button,
USB disconnect, or closing the backend ends collection. Switching dashboard
pages does not. Reconnect and click **Connect & start** after an unplug or
backend restart; capture does not silently resume into an old case.

If more than one CP2102 board is present, choose its USB port. Close any serial
monitor that is using the port. If installation fails while connecting,
briefly hold BOOT and retry. Missing USB data cable, board, tools, or sensor
readings produces an explicit error; it never substitutes fake sensor data.
