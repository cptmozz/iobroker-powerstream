# Ecoflow PowerStream Output Adjustment Script

This script connects to the Ecoflow cloud and dynamically adjusts the power requirements of the PowerStream Inverter based on real-time household electricity consumption. 

It needs a smart meter interfaced with [ioBroker](https://www.iobroker.net/) to transmit the current house consumption data.

## Motivation
Direct modifications to the Ecoflow PowerStream functionalities have proven challenging and prone to conflicts, particularly after firmware updates.
This script offers a practical solution by automatically adjusting household power usage, emulating manual adjustments typically done through the Ecoflow app.

All other Ecoflow settings and functionalities, including battery management and priority settings, remain unchanged and continue to be managed through the Ecoflow app.

## Use Cases
This script serves as a foundational tool for:
- Developing custom functionalities.
- Integrating with different smart home automation systems.
- Extending compatibility with various adapters and microcontrollers.

## Installation Guide

### Script Configuration
To set up the script in ioBroker:
1. Navigate to the scripts section in ioBroker.
2. Import the script directly from GitHub by pasting the content from [this link](https://raw.githubusercontent.com/cptmozz/iobroker-powerstream/main/powerstream-output-control.js).
3. Modify the script to include your Ecoflow account email, password, and the serial number (SN) of your PowerStream device.

#### Dependencies
Before running the script, ensure the necessary npm modules are installed. You will need `mqtt` and `protobufjs`. Refer to the modules' installation guide here:
![npm modules installation guide](https://powerstream-connect.web.app/npm-modules.png).

### Smart Meter Integration
To interface a smart meter with ioBroker using MQTT:
1. Follow a detailed tutorial on setting up an MQTT server/broker within ioBroker, such as this comprehensive guide (in German): [Tasmota LeseKopf mit ioBroker](https://bayha-electronics.de/tutorials/tasmota-lesekopf-iobroker/).
2. Once the MQTT server is configured, and data transmission is established, navigate to the object tree in ioBroker.
3. Locate and copy the full variable name representing the Watt value from the smart meter data. Depending on your setup, a Read converter might be required to extract the wattage directly.

Finally, enter the copied variable name into the script's `SMART_METER_WATT_STATE` to link the smart meter readings with the script.

By following these steps, the script and smart meter setup will be properly configured to dynamically adjust the PowerStream Inverter's output based on real-time consumption data directly from your smart meter.


## Credits
The script is based on reverse engineering of the script contributed by [waly_de](https://forum.iobroker.net/user/waly_de).
