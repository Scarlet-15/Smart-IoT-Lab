#include <WiFi.h>
#include <PubSubClient.h>

#define PIR_PIN 13
#define LED_PIN 2

const char* ssid = "jhu";
const char* password = "passcode";
const char* mqtt_server = "10.168.190.65";

WiFiClient espClient;
PubSubClient client(espClient);

bool lastState = LOW;

void setup_wifi() {
  Serial.print("Connecting to WiFi...");
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi Connected");
}

void reconnect() {
  while (!client.connected()) {
    Serial.print("Connecting to MQTT...");
    if (client.connect("ESP32Client")) {
      Serial.println("Connected");
    } else {
      Serial.print("Failed, rc=");
      Serial.print(client.state());
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(PIR_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);

  setup_wifi();
  client.setServer(mqtt_server, 1884);

  Serial.println("System Ready");
}

void loop() {

  if (!client.connected()) reconnect();
  client.loop();

  int motion = digitalRead(PIR_PIN);

  // LED indication
  if (motion == HIGH) {
    digitalWrite(LED_PIN, HIGH);
  } else {
    digitalWrite(LED_PIN, LOW);
  }

  // ✅ Send ONLY when motion starts
  if (motion == HIGH && lastState == LOW) {
    Serial.println("Motion Detected → Sending MQTT");
    client.publish("lab/pc/status", "active");
  }

  // Debug
  if (motion == LOW && lastState == HIGH) {
    Serial.println("Motion Ended");
  }

  lastState = motion;

  delay(200);
}