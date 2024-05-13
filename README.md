# Ecoflow PowerStream with Smart Meter Output Adjustment Script

## Description
This script connects to the Ecoflow cloud and dynamically adjusts the power requirements of the PowerStream Inverter based on real-time household electricity consumption. It utilizes a smart meter interfaced with ioBroker to transmit the current house consumption data.

## Motivation
Direct modifications to the Ecoflow PowerStream functionalities have proven challenging and prone to conflicts, particularly after firmware updates. This script offers a practical solution by automatically adjusting household power usage, emulating manual adjustments typically done through the Ecoflow app.

All other Ecoflow settings and functionalities, including battery management and priority settings, remain unchanged and continue to be managed through the Ecoflow app.

## Use Cases
This script serves as a foundational tool for:
- Developing custom functionalities.
- Integrating with different smart home automation systems.
- Extending compatibility with various adapters and microcontrollers.

## Prerequisites
- A smart meter interfaced with ioBroker.
