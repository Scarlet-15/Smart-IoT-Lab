# Smart IoT Lab

**An integrated, cloud-backed IoT platform for academic electronics laboratories.**  
Automates lab entry, lighting, workstation management, and component lending — with ML-verified returns.

---

## What it does

Smart IoT Lab replaces manual laboratory management with four automated modules that share a single Firebase Realtime Database as their backbone.

### 1 · Lab Entry Monitoring
Students tap their RFID card on an MFRC522 reader connected to an ESP32. The card UID is verified against Firebase. Registered users unlock the door; every tap — authorized or not — is logged with a timestamp.

### 2 · Automated Lighting
PIR motion sensors cover up to four zones of the lab. The ESP32 turns lights on the moment presence is detected in a zone and switches them off after a configurable idle period (default: 5 minutes). Zone states sync to Firebase in real time for remote monitoring.

### 3 · Workstation Usage Monitoring
The ESP32 tracks activity at each workstation. When a station has been idle beyond a set threshold (default: 10 minutes), it publishes an MQTT shutdown command to a Mosquitto broker. The workstation runs a lightweight subscriber that executes a graceful shutdown. All events are logged to Firebase.

### 4 · Component Lending and Return
Students authenticate by RFID, browse available components on a React web dashboard, and submit a borrow request. The ESP32 reads the request from Firebase and rotates an SG90 servo motor to open the correct component compartment. When components are returned, a Raspberry Pi camera captures an image of the return tray. A YOLOv11 model hosted on Roboflow counts and classifies the components. If the detection matches the declared return quantity, the return slot opens. If there is a mismatch or a defect, the student sees the annotated image and exact discrepancy details before being prompted to correct the items.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                   Firebase Realtime Database                  │
│         (single source of truth for all modules)             │
└────────────┬────────────────┬────────────────┬───────────────┘
             │                │                │
    ┌────────▼───────┐ ┌──────▼──────┐ ┌──────▼──────────────┐
    │   ESP32 Main   │ │ Raspberry   │ │  React Web App      │
    │  · RFID entry  │ │ Pi Camera   │ │  + Node.js Backend  │
    │  · PIR lights  │ │  · /capture │ │  · Borrow dashboard │
    │  · MQTT shutdown│ │  · /stream  │ │  · Return + scan UI │
    │  · Servo motors│ │  · /stop    │ │  · POST /scan → RF  │
    └────────────────┘ └─────────────┘ └─────────────────────┘
                                               │
                                     ┌─────────▼──────────┐
                                     │  Roboflow YOLOv11  │
                                     │  Object Detection  │
                                     │  mAP@50 = 94.9%    │
                                     └────────────────────┘
```

---

## Hardware

| Component | Model | Role |
|---|---|---|
| Main microcontroller | ESP32-WROOM-32 | RFID, PIR, servo, MQTT, Firebase |
| RFID reader | MFRC522 | Student card authentication |
| Motion sensors | HC-SR501 PIR (×4) | Zone occupancy detection |
| Servo motors | SG90 (×2) | Component compartment doors |
| Relay module | 5V 4-channel | Lighting zones + door lock |
| Door actuator | 12V electromagnetic | Physical lab entry lock |
| Vision module | Raspberry Pi 4 + Camera v2 | Return tray image capture |
| MQTT broker | Mosquitto on RPi/PC | Workstation shutdown commands |

**Servo GPIO mapping:** GPIO 25 → LED compartment · GPIO 26 → Resistor compartment

---

## Software Stack

| Layer | Technology |
|---|---|
| Firmware | Arduino (ESP32), FirebaseClient, ESP32Servo, MFRC522, PubSubClient |
| Camera server | Python + Flask + PiCamera2 (Raspberry Pi) |
| Web frontend | React 18, Firebase JS SDK v10, Vite |
| ML backend | Node.js, Express, Axios, Firebase Admin SDK |
| Object detection | Roboflow hosted YOLOv11 |
| Database | Firebase Realtime Database |
| Messaging | MQTT (Mosquitto broker) |
| Hosting | Firebase Hosting |

---

## ML Model Performance

Trained on a custom electronic components dataset (LEDs and resistors).

| Metric | Value |
|---|---|
| mAP@50 | **94.9 %** |
| Precision | **92.4 %** |
| Recall | **84.1 %** |
| F1 Score | **88.0 %** |

> Model hosted at [Roboflow Universe — electronic-ckryv](https://universe.roboflow.com/resistancecapacitancediode-rauxj/electronic-ckryv)

---

## Firebase Database Schema

```
/users/{uid}/name                    Student display name
/components/{key}/quantity           Current stock level
/rfid_taps/latest/uid                Last tapped card UID
/borrow_records/{key}                Active borrow requests
/borrow_list/{uid}/{key}             Components currently held per student
/return_records/{key}                Active return requests
/entry_log/{key}                     Lab entry audit trail
/lighting/{zone}                     Zone occupancy states
/workstation_log/{key}               Workstation shutdown events
```

---

## Team

| Name | Roll No. |
|---|---|
| B. Mhanjhu Sriee | 206125004 |
| Samiksha Pathare | 206125019 |

**Guide:** Dr. Nithya  
**Department:** Computer Science and Engineering  
**Institution:** National Institute of Technology, Tiruchirappalli  
**Programme:** M.Tech CSE · 2025–27
