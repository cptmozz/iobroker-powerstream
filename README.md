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

## Prerequisites
- A smart meter interfaced with ioBroker.

## Credits
The script is based on reverse engineering of the script contributed by [waly_de](https://forum.iobroker.net/user/waly_de).
