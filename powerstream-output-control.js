const CONFIG = {
  EMAIL: "YOUR_ECOFLOW_ACCOUNT_EMAIL", // Your personal Ecoflow Login Data
  PASSWORD: "YOUR_ECOFLOW_ACCOUNT_PASSWORD", // Your personal Ecoflow password
  // Login credentials are used solely for authentication with the Ecoflow server and to establish an MQTT connection via a POST request to api.ecoflow.com/auth/login.
  SMART_METER_WATT_STATE: "IOBROKER_SMART_METER_STATE_ALIAS", // name/alias of the iobroker state variable for the current house consumption in watts from the smart meter.
  // ======================================================================
  // Set tolerable wattage limits to reduce unnecessary adjustments and minimize the frequency of requests to the Ecoflow cloud.
  // Each request to Ecoflow is logged. I recommend monitoring the logs after making adjustments to settings to reduce the risk of triggering Ecoflow's DDoS mitigation measures.
  // ======================================================================
  TARGET_WATT: 10, // Specifies the target power level for the smart meter as aimed by the script. Setting this above 0 helps reduce the frequency of excess power being sent to the grid, thereby decreasing instances of negative consumption recorded by the smart meter.
  MIN_WATT_THRESHOLD: -10, // Script will adjust feed-in power only if house consumption, as measured by the smart meter, drops below this limit.
  MAX_WATT_THRESHOLD: 30, // Script will adjust feed-in power only if house consumption exceeds this limit. Don't worry about setting a high value here. You will usually end up having around 0 Watts actual house consumption.
  TOLERABLE_WATT_CHANGE: 10, // Minimum change in wattage (+/- watts) needed to trigger a power adjustment. This helps avoid frequent minor adjustments.
  // EXAMPLE: With a TOLERABLE_WATT_CHANGE of 10, a change in house consumption from 100W to 107W does not trigger a new request to the Ecoflow cloud.
  // NOTE: House consumption may sometimes exceed the positive and negative TOLERABLE_WATT_LIMITS by up to the TOLERABLE_WATT_CHANGE value.
  // ======================================================================

  CHECK_INTERVAL_MILLIS: 5000, // The interval in milliseconds to check the house consumption and adjust the inverter output.

  DEVICES: [
    // Only one power stream device is supported for now. Supporting other devices can be implemented here.
    {
      SN: "POWERSTREAM_SERIAL_NUMBER", // The PowerStream serial number. Can be found in the Ecoflow app or on the device.
      MAX_WATT_OUT: 600, // The maximum inverter output in watt. This should be equal to the maximum feed-in power of your inverter.
      FALLBACK_OUT: 80, // Default feed-in power if no recent smart meter data is available. This should be the minimum house consumption value. Inverter will never go below this value.

      // ======================================================================
      // DAY and NIGHT Mode |  Helps manage battery usage efficiently during nighttime by setting a limit on power output.
      MAX_NIGHT_OUT: 200, // The maximum inverter output in watt during nighttime. This value should be lower than MAX_WATT_OUT. If no limit is desired, set this value to -1.
      // If MAX_NIGHT_OUT functionality is enabled consider adjusting MINUTES_AFTER_SUNRISE and  MINUTES_BEFORE_SUNSET to define the window around sunrise and sunset to be considered as high-output hours for solar panels.
      MINUTES_AFTER_SUNRISE: 120, // Defines the duration after sunrise considered as high-output hours for solar panels. Adjust this based on when sunlight begins to effectively reach your panels in the morning.
      MINUTES_BEFORE_SUNSET: 170, // Specifies the duration before sunset that is considered as high-output hours for solar panels. Adjust this setting based on when sunlight remains effective on your panels in the evening.
      // ======================================================================

      LOG_EACH_ADJUSTMENT: true, // If set to true, each request to the Ecoflow cloud will be logged. This can be useful for monitoring the script's behavior.
      CONTINUE_WHEN_INVERTER_IN_STANDBY: true, // If set to true, the script will continue to adjust the inverter output even when the inverter is not outputting. Otherwise, adjustments will be paused until the inverter is feeding power again.
      SUBSCRIBE: true, // This script needs to subscribe to the PowerStream's properties to receive the inverter's actual output and battery status.
    },
  ],
};

const mqtt = require("mqtt");
const https = require("https");
const protobuf = require("protobufjs");

// Keeping track of inverter outputs.
let acknowledgedInverterOut = { watt: 0, ts: 0 }, // Represents the cloud's confirmation of the requested output.
  actualInverterOut = { watt: 0, ts: 0 }, // confirmed via MQTT subscription, provides the most reliable update on output, but can take significantly longer to reflect true changes.
  requestedInverterOut = { watt: 0, ts: 0 }, // tracks the last sent request, because changes can occasionally be disregarded by the Ecoflow cloud.
  batteryOut = { watt: 0, ts: 0 }, // A negative 'watt' value indicates the battery is charging.
  batteryState = { pct: 0, ts: 0 }, // Initially unset until the battery percentage changes, which may take some time.
  hourlyMetrics = {
    requests: 0,
    inverter: [],
    battery: [],
    batteryPCT: 0,
    reset: Date.now(),
  }; // Tracks the number of requests sent and the total watt-hours output by the inverter.

// This is the main function that adjusts the inverter output based on the current house consumption. It is currently set to run every 5 seconds (CHECK_INTERVAL_MILLIS).
// It also checks if the smart meter data is outdated and applies the fallback output if necessary.
// If you have any custom logic to adjust the inverter output, you can implement it here.
function adjustInverterOutput() {
  const device = CONFIG.DEVICES[0]; // only one device supported for now
  const smartMeterWattState = getState(CONFIG.SMART_METER_WATT_STATE); // IOBroker specific getState function
  const currentMaxOutput = getCurrentMaxOutput(device);

  const { adjustAC, setFallback, reason } = isOutputAdjustmentRequired(
    device,
    smartMeterWattState,
    currentMaxOutput
  );
  // logStats();

  if (setFallback) {
    sendNewACOutput(device, device.FALLBACK_OUT, reason);
    return;
  }
  if (adjustAC) {
    let newValue =
      actualInverterOut.watt + smartMeterWattState.val - CONFIG.TARGET_WATT; // Calculate the Watts needed
    newValue = Math.min(newValue, currentMaxOutput); // limit to currentMaxOutput
    newValue = Math.max(newValue, device.FALLBACK_OUT); // not below fallback
    sendNewACOutput(device, newValue, reason);
  }
}

function isOutputAdjustmentRequired(
  device,
  smartMeterWattState,
  currentMaxOutput
) {
  // Checking if smart meter data is up-to-date and available.
  if (!smartMeterWattState) {
    log(`SmartMeter state ${CONFIG.SMART_METER_WATT_STATE} not found`, "error");
    return {
      adjustAC: false,
      setFallback: false,
      reason: "SmartMeter not found",
    };
  }
  if (smartMeterWattState.ts === 0) {
    log("No smart meter signal received yet", "error");
  }
  log("SmartMeter watt: " + smartMeterWattState.val, "debug");
  // Do not process if the smart meter or inverter data is outdated.
  if (isOutdated(smartMeterWattState) || isOutdated(actualInverterOut)) {
    if (
      isOutdated(smartMeterWattState) &&
      requestedInverterOut.watt !== device.FALLBACK_OUT
    ) {
      log(
        `SmartMeter data is outdated - applying fallback ${device.FALLBACK_OUT} Watt`,
        "debug"
      );
      return {
        adjustAC: false,
        setFallback: true,
        reason: "SmartMeter Outdated - Fallback Power",
      };
    }
    return {
      adjustAC: false,
      setFallback: false,
      reason: "SmartMeter already at fallback",
    };
  }

  // Adjustments are only made if data from SmartMeter or actualInverterOut are more recent than the previous check interval.
  if (
    isFromEarlierCycle(smartMeterWattState) ||
    (isFromEarlierCycle(actualInverterOut) &&
      actualInverterOut.watt !== acknowledgedInverterOut.watt) // Check if the acknowledged and actual inverter outputs differ, indicating possible ongoing adjustments.
  ) {
    // Postpone any adjustments to the next cycle
    return {
      adjustAC: false,
      setFallback: false,
      reason: isFromEarlierCycle(smartMeterWattState)
        ? "SmartMeter delay"
        : "Inverter delay",
    };
  }

  if (requestedInverterOut.watt === 0 && requestedInverterOut.ts === 0) {
    return { adjustAC: true, setFallback: false, reason: "Initial adjustment" };
  }

  // Ecoflow sometimes silently ignores setAC calls, so we need to re-send the request if no acknowledgment is received.
  if (
    isOutdated(acknowledgedInverterOut) &&
    requestedInverterOut.watt !== acknowledgedInverterOut.watt
  ) {
    if (requestedInverterOut.ts - 15000 > acknowledgedInverterOut.ts) {
      log("Ecoflow Cloud did not acknowledge the last request. Retrying.");
      return { adjustAC: true, setFallback: true, reason: "No acknowledgment" };
    }

    return {
      adjustAC: false,
      setFallback: false,
      reason: "Waiting for acknowledgment",
    };
  }
  if (acknowledgedInverterOut.ts > actualInverterOut.ts) {
    return {
      adjustAC: false,
      setFallback: false,
      reason: "Waiting for actual output",
    };
  }

  // Do not adjust if the inverter is off or in standby mode.
  if (
    !device.CONTINUE_WHEN_INVERTER_IN_STANDBY &&
    actualInverterOut.watt === 0 &&
    acknowledgedInverterOut.watt > 0
  ) {
    return {
      adjustAC: false,
      setFallback: false,
      reason: "Inverter off/standby",
    };
  }

  // Adjust the inverter output if the house consumption exceeds the maximum output.
  const houseNeed =
    smartMeterWattState.val + actualInverterOut.watt - CONFIG.TARGET_WATT;

  if (houseNeed > currentMaxOutput) {
    return {
      adjustAC: true,
      setFallback: false,
      reason: "Power shift - Output Limit",
    };
  }

  // Re-adjust if the inverter output is more than requested and the battery is discharging or the house consumption is higher.
  if (
    actualInverterOut.ts > acknowledgedInverterOut.ts &&
    actualInverterOut.watt > acknowledgedInverterOut.watt + 10
  ) {
    // When clouds are passing by, the battery might discharge a bit. Only adjust if it discharges more than 30W.
    if (batteryOut.watt > 30) {
      return {
        adjustAC: true,
        setFallback: false,
        reason: "Excess Battery Output",
      };
    } else if (smartMeterWattState.val >= CONFIG.MAX_WATT_THRESHOLD) {
      return {
        adjustAC: true,
        setFallback: false,
        reason: "Power Shift - Output to low ",
      };
    } else {
      // Inverter is outputting more than requested. Battery is probably fully charged. Do not adjust.
      return { adjustAC: false, setFallback: false, reason: "Battery Full" };
    }
  }

  // Only now we check if the change in wattage exceeds the defined delta.
  const smartMeterWatt = smartMeterWattState.val;
  if (
    smartMeterWatt >= CONFIG.MIN_WATT_THRESHOLD &&
    smartMeterWatt <= CONFIG.MAX_WATT_THRESHOLD
  ) {
    return {
      adjustAC: false,
      setFallback: false,
      reason: "Power Level OK",
    };
  }

  return {
    adjustAC: true,
    setFallback: false,
    reason: "Power Shift",
  };
}

function sendNewACOutput(device, value, reason) {
  value = Math.max(0, value);
  value = Math.round(value);
  if (
    Math.abs(requestedInverterOut.watt - value) <= CONFIG.TOLERABLE_WATT_CHANGE
  ) {
    if (requestedInverterOut.watt !== CONFIG) return;
  }
  //logAll();
  sendAC(device, value);

  if (device.LOG_EACH_ADJUSTMENT) {
    const smartMeter = getState(CONFIG.SMART_METER_WATT_STATE);
    const smartMeterVal =
      isOutdated(smartMeter) && isOutdated(actualInverterOut)
        ? ""
        : ` 🏠${actualInverterOut.watt + smartMeter.val}W`;

    log(`️Adjust to ${value}W [${reason}]${smartMeterVal}`);
  }
}

function getCurrentMaxOutput(device) {
  if (device.MAX_NIGHT_OUT === -1) {
    return device.MAX_WATT_OUT;
  }
  const isDayLightCore = isCurrentlyDaylightCore(device);
  return isDayLightCore ? device.MAX_WATT_OUT : device.MAX_NIGHT_OUT;
}

let isDaylightCoreMode;

function isCurrentlyDaylightCore(device) {
  const sunrise = getAstroDate("sunrise"); // IOBroker specific function
  const sunset = getAstroDate("sunset"); // IOBroker specific function
  const afterSunrise =
    sunrise.getTime() + device.MINUTES_AFTER_SUNRISE * 60 * 1000;
  const beforeSunset =
    sunset.getTime() - device.MINUTES_BEFORE_SUNSET * 60 * 1000;
  const isCoreDaylight = afterSunrise < Date.now() && beforeSunset > Date.now();
  if (isDaylightCoreMode !== isCoreDaylight) {
    const switchTime = isCoreDaylight ? beforeSunset : afterSunrise;

    const switchTimeStr = ` - Switching to ${
      isCoreDaylight ? "night" : "day"
    } mode at ${new Date(switchTime).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`;

    log(
      isCoreDaylight
        ? `☀️ DAY MODE - Max Output ${device.MAX_WATT_OUT}W${switchTimeStr}`
        : `🌘 NIGHT MODE - Max Output ${device.MAX_NIGHT_OUT}W${switchTimeStr}`
    );

    isDaylightCoreMode = isCoreDaylight;
  }
  return isCoreDaylight;
}

function generateHourlyReport() {
  const now = Date.now();
  if (now - hourlyMetrics.reset > 60 * 60 * 1000) {
    const totalWattHours = calculateWattHours();
    const batteryMetrics = calculateBatteryMetrics();
    log(
      `HOURLY STATS: 🔌 Inverter (Out: ${totalWattHours}Wh, Adjusts: ${hourlyMetrics.requests}) - 🔋 Battery ${hourlyMetrics.batteryPCT}% to ${batteryState.pct}% (Charge: ${batteryMetrics.charge}Wh, Discharge: ${batteryMetrics.discharge}Wh)`
    );

    hourlyMetrics = {
      requests: 0,
      reset: now,
      inverter: [],
      battery: [],
      batteryPCT: batteryState.pct,
    };
  }
}

function calculateBatteryMetrics() {
  let charge = 0;
  let discharge = 0;
  let batteryReadings = hourlyMetrics.battery;

  if (batteryReadings.length < 2) {
    // Not enough data to calculate energy metrics
    return { charge: 0, discharge: 0 };
  }

  // Calculate total time first for average calculation
  const startTime = batteryReadings[0].ts;
  const endTime = batteryReadings[batteryReadings.length - 1].ts;
  const totalTime = (endTime - startTime) / 3600;

  for (let i = 1; i < batteryReadings.length; i++) {
    const previous = batteryReadings[i - 1];
    const current = batteryReadings[i];
    const timeDiffHours = (current.ts - previous.ts) / 3600;
    const wattHours = previous.watt * timeDiffHours;

    if (previous.watt < 0) {
      charge += Math.abs(wattHours); // Accumulate absolute value for charging
    } else {
      discharge += wattHours; // Accumulate discharging
    }
  }
  return {
    charge: Math.round(charge / totalTime),
    discharge: Math.round(discharge / totalTime),
  };
}

function calculateWattHours() {
  if (hourlyMetrics.inverter.length < 2) {
    // Not enough data to calculate watt-hours
    return 0;
  }

  let totalWattHours = 0;
  const readings = hourlyMetrics.inverter;

  // Calculate total time first for average calculation
  const startTime = readings[0].ts;
  const endTime = readings[readings.length - 1].ts;
  const totalTime = (endTime - startTime) / 3600;

  for (let i = 1; i < readings.length; i++) {
    const previous = readings[i - 1];
    const current = readings[i];
    const timeDiffHours = (current.ts - previous.ts) / 3600; // Convert time difference from seconds to hours
    const wattHours = previous.watt * timeDiffHours; // Calculate watt-hours for this segment
    totalWattHours += wattHours;
  }

  return Math.round(totalWattHours / totalTime);
}

function isOutdated(state) {
  // requires state.ts to be set
  if (state.ts === undefined) {
    log("State.ts is not set. Cannot determine if state is outdated.", "error");
  }
  return state.ts < Date.now() - 30 * 1000; // + 30 seconds == outdated
}

function isFromEarlierCycle(state) {
  const STALE_THRESHOLD_MS = Math.min(CONFIG.CHECK_INTERVAL_MILLIS, 5000);
  return state.ts < Date.now() - STALE_THRESHOLD_MS;
}

function checkProperties() {
  if (!CONFIG.EMAIL || !CONFIG.PASSWORD) {
    log(
      "Please set your Ecoflow email and password in the CONFIG section.",
      "error"
    );
    return false;
  }
  if (!CONFIG.DEVICES || CONFIG.DEVICES.length === 0) {
    log("Please add at least one device in the CONFIG section.", "error");
    return false;
  }
  const device = CONFIG.DEVICES[0];
  if (!device.SN || device.SN.length < 16) {
    log(
      "Please set the serial number of your device in the CONFIG section.",
      "error"
    );
    return false;
  }
  if (CONFIG.MIN_WATT_THRESHOLD + 10 > CONFIG.TARGET_WATT) {
    log(
      "Please set MIN_WATT_THRESHOLD at least 10W below TARGET_WATT.",
      "error"
    );
    return false;
  }
  if (CONFIG.MAX_WATT_THRESHOLD - 10 < CONFIG.TARGET_WATT) {
    log(
      "Please set MAX_WATT_THRESHOLD at least 10W above TARGET_WATT.",
      "error"
    );
    return false;
  }
  if (CONFIG.CHECK_INTERVAL_MILLIS < 3000) {
    log(
      "Setting the update interval to less than 3 seconds may result in infrequent adjustments. It becomes unlikely that both SmartMeter and actual inverter output data will consistently align within such a brief period.",
      "warn"
    );
    return true;
  }

  return true;
}

if (!checkProperties()) {
  log("Script stopped due to missing configuration.", "error");
  stopScript();
}

/**
 * =============================================================================
 * Authentication and MQTT Connection Setup for Ecoflow Server
 * =============================================================================
 * The rest of this script is dedicated to:
 * - Authenticating with the Ecoflow server.
 * - Establishing and managing the MQTT connection.
 * - Handling incoming MQTT messages from the Ecoflow server.
 *
 * Do not modify the code below unless you are well-versed with the
 * Ecoflow MQTT protocol. Modifications could disrupt communication stability.
 *
 * NOTE: This code section still requires cleanup. Some properties are outdated
 * and need to be removed or updated. Proceed with caution when making changes.
 * =============================================================================
 */

const ECOFLOW_WATT_MODIFIER = 10; // Ecoflow handles 1W as 10Watt. Don't know why.
let housePowerCheckInterval, simulateAppHeartbeatInterval;
let isMqttConnected = false;
let lastMQTTMessageFromEcoflow;

// Authenticate with Ecoflow and setup MQTT connection
let mqttData = await authenticateWithEcoflow();
let mqttClient = setupMQTTConnection();

async function authenticateWithEcoflow() {
  const options = {
    hostname: "api.ecoflow.com",
    path: "/auth/login",
    method: "POST",
    headers: {
      Host: "api.ecoflow.com",
      "content-type": "application/json",
    },
  };

  const credentials = {
    email: CONFIG.EMAIL,
    password: Buffer.from(CONFIG.PASSWORD).toString("base64"),
    scene: "IOT_APP",
    userType: "ECOFLOW",
  };

  log("Authenticating with email and password...");
  let response = await httpsRequest(options, credentials);
  let data = response.data;
  let token, userId;
  try {
    token = data.token;
    userId = data.user.userId;
  } catch (error) {
    throw new Error(
      "Error authenticating with Ecoflow. Please check your credentials.",
      error
    );
  }

  // Get certificate data
  options.path = `/iot-auth/app/certification?userId=${userId}`;
  options.method = "GET";
  options.headers.authorization = `Bearer ${token}`;
  response = await httpsRequest(options);
  data = response.data;
  log("Certificate data received from Ecoflow. Authentication successful");
  return {
    password: data.certificatePassword,
    port: data.port,
    userId,
    user: data.certificateAccount,
    URL: data.url,
    protocol: data.protocol,
    clientId: `ANDROID_${uuidv4()}_${userId}`,
  };

  function httpsRequest(options, data) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseData = "";

        res.on("data", (chunk) => {
          responseData += chunk;
        });

        res.on("end", () => {
          try {
            const parsedData = JSON.parse(responseData);
            resolve(parsedData);
          } catch (error) {
            log(`Error parsing response JSON: ${error}`, "error");
            reject(error);
          }
        });
      });

      req.on("error", (error) => {
        log(`Error calling ${options.path}: ${error}`, "error");
        reject(error);
      });

      if (data) {
        req.write(JSON.stringify(data));
      }
      req.end();
    });
  }

  function uuidv4() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) =>
      (c === "x"
        ? (Math.random() * 16) | 0
        : 0x8 | ((Math.random() * 4) | 0)
      ).toString(16)
    );
  }
}

function setupMQTTConnection() {
  log("Connecting to Ecoflow MQTT broker.");
  clearIntervalAndReset(simulateAppHeartbeatInterval);
  clearIntervalAndReset(housePowerCheckInterval);

  const options = {
    port: mqttData.port,
    clientId: mqttData.clientId,
    username: mqttData.user,
    password: mqttData.password,
    protocol: mqttData.protocol,
  };

  const mqttClient = mqtt.connect(`mqtt://${mqttData.URL}`, options);
  mqttClient.on("message", async (topic, mqttMsg) => {
    lastMQTTMessageFromEcoflow = Date.now();
    const msg = decodeBinaryData(mqttMsg.toString("hex"));

    if (msg) {
      log("Ecoflow decodedMsg: " + JSON.stringify(msg), "debug");
      if (msg.SetAC !== undefined) {
        const value = Math.round(msg.SetAC.value / ECOFLOW_WATT_MODIFIER);
        acknowledgedInverterOut = { watt: value, ts: Date.now() }; // only storing when acknowledged
      } else if (msg.InverterHeartbeat) {
        if (msg.InverterHeartbeat.invOutputWatts !== undefined) {
          const value = Math.round(
            msg.InverterHeartbeat.invOutputWatts / ECOFLOW_WATT_MODIFIER
          );
          actualInverterOut = { watt: value, ts: Date.now() };
        }
        if (msg.InverterHeartbeat.batInputWatts !== undefined) {
          const value = Math.round(
            msg.InverterHeartbeat.batInputWatts / ECOFLOW_WATT_MODIFIER
          );
          batteryOut = { watt: value, ts: Date.now() };
        }
        if (msg.InverterHeartbeat.batSoc !== undefined) {
          const value = msg.InverterHeartbeat.batSoc;
          batteryState = { pct: value, ts: Date.now() };
          if (!hourlyMetrics.batteryPCT) {
            hourlyMetrics.batteryPCT = value;
          }
        }
      }
    }
  });

  mqttClient.on("connect", () => {
    log("Connected to Ecoflow MQTT broker");
    isMqttConnected = true;

    CONFIG.DEVICES.forEach((item) => {
      const deviceTopic = `/app/${mqttData.userId}/${item.SN}/thing/property/set`;
      mqttClient.subscribe(deviceTopic);

      // The only reason to subscribe to this topic is to prevent Ecoflow from dropping the connection after a few minutes.
      mqttClient.subscribe(
        `/app/${mqttData.userId}/${item.SN}/thing/property/get`
      );

      if (item.SUBSCRIBE) {
        const propertyTopic = `/app/device/property/${item.SN}`;
        mqttClient.subscribe(propertyTopic);
      }
    });

    housePowerCheckInterval = setInterval(() => {
      if (
        lastMQTTMessageFromEcoflow &&
        lastMQTTMessageFromEcoflow < Date.now() - 5 * 60 * 1000
      ) {
        reconnect();
      } else {
        adjustInverterOutput();

        if (!isOutdated(actualInverterOut)) {
          hourlyMetrics.inverter.push({
            watt: actualInverterOut.watt,
            ts: Date.now(),
          });
        }
        if (!isOutdated(batteryOut)) {
          hourlyMetrics.battery.push({ watt: batteryOut.watt, ts: Date.now() });
        }
        generateHourlyReport();
      }
    }, CONFIG.CHECK_INTERVAL_MILLIS); // every 5 seconds

    simulateAppHeartbeatInterval = setInterval(() => {
      if (isMqttConnected) {
        CONFIG.DEVICES.forEach((item) => sendPing(item.SN));
      }
    }, 32 * 1000);
  });

  mqttClient.on("close", () => {
    isMqttConnected = false;
  });

  mqttClient.on("error", (error) => {
    log(`Mqtt error: ${error}`, "warn");
  });

  mqttClient.on("reconnect", () => {
    log("Received reconnect event from MQTT broker");
    reconnect();
  });

  return mqttClient;
}

function clearIntervalAndReset(interval) {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

onStop(function (callback) {
  log("Script stopped");
  if (mqttClient) {
    log("Closing MQTT connection...");
    mqttClient.end();
  }
  callback();
}, 1000);

async function reconnect() {
  log("Reconnecting to Ecoflow MQTT broker..."); //
  mqttClient.end(); // disconnect
  // to prevent different issues simply reauthenticate and setup a new connection
  mqttData = await authenticateWithEcoflow();
  mqttClient = await setupMQTTConnection();
}

function sendPing(sn) {
  const basicGET = {
    header: {
      src: 32,
      dest: 32,
      seq: Date.now(),
    },
  };
  sendProto(basicGET, `/app/${mqttData.userId}/${sn}/thing/property/get`);
}

function sendAC(device, value) {
  requestedInverterOut = { watt: value, ts: Date.now() };
  hourlyMetrics.requests++;
  const newAC = value * ECOFLOW_WATT_MODIFIER;
  sendProto(
    {
      header: {
        pdata: {
          value: newAC,
        },
        src: 32,
        dest: 53,
        dSrc: 1,
        dDest: 1,
        checkType: 3,
        cmdFunc: 20,
        cmdId: 129,
        dataLen: getVarintByteSize(newAC),
        needAck: 1,
        seq: Date.now(),
        version: 19,
        payloadVer: 1,
        deviceSn: device.SN,
      },
    },
    `/app/${mqttData.userId}/${device.SN}/thing/property/set`
  );
}

function sendProto(protoMsg, topic) {
  //return
  const root = protobuf.parse(protoSource).root;
  const PowerMessage = root.lookupType("setMessage");
  const message = PowerMessage.create(protoMsg);
  const messageBuffer = PowerMessage.encode(message).finish();

  mqttClient.publish(topic, messageBuffer, { qos: 1 }, function (error) {
    if (error) {
      console.error("Error publishing MQTT message:", error);
    }
  });
}

function logAll(logLevel = "info") {
  const smartMeter = getState(CONFIG.SMART_METER_WATT_STATE);
  const allValues = {
    actualOut: isOutdated(actualInverterOut)
      ? "NO_DATA"
      : `${actualInverterOut.watt}${formatTimestamp(actualInverterOut.ts)}`,
    requestedOut: `${requestedInverterOut.watt}${formatTimestamp(
      requestedInverterOut.ts
    )}`,
    acknowledgedOut: `${acknowledgedInverterOut.watt}${formatTimestamp(
      acknowledgedInverterOut.ts
    )}`,
    battery: isOutdated(batteryOut)
      ? "NO_DATA"
      : `${
          batteryOut.watt >= 0
            ? batteryOut.watt
            : batteryOut.watt + "(charging)"
        }${formatTimestamp(batteryOut.ts)}`,
    smartMeter: isOutdated(smartMeter)
      ? "NO_DATA"
      : `${smartMeter.val}${formatTimestamp(smartMeter.ts)}`,
    requestPerHour: requestCounter.count,
  };
  log(JSON.stringify(allValues).replace(/[{}"]/g, ""), logLevel);
}

function formatTimestamp(timestamp) {
  const now = Date.now();
  const elapsed = Math.floor((now - timestamp) / 1000); // Convert milliseconds to seconds
  return `(${elapsed}s)`;
}

function decodeBinaryData(binary) {
  const hexString = binary.toString("hex");
  const root = protobuf.parse(protoSource).root;
  const protobufMsg = root.lookupType("Message");

  let message = {};
  let jsonResult = {};
  try {
    message = protobufMsg.decode(Buffer.from(hexString, "hex"));
  } catch (error) {
    // Not yet defined protobuf message - ignore for now
    return {};
  }

  // first check message.header is an array and if so the build a new array with that single header
  if (!Array.isArray(message.header)) {
    log("message.header:" + JSON.stringify(message.header));
    message.header = [message.header];
  }

  for (const header of message.header) {
    const sn = header.deviceSn;
    const entry =
      ecoflowDevicePropertiesCatalog.find(
        (entry) => entry.id === header.cmdId && entry.cmdFunc === header.cmdFunc
      ) || null;

    if (entry != null) {
      const protoBufMsg = root.lookupType(entry.template);
      const pdata = protoBufMsg.decode(header.pdata);
      const pdataObj = protoBufMsg.toObject(pdata, {
        longs: Number, // convert Long values to Number
        enums: String, // convert Enum values to String names
        bytes: Buffer, // convert bytes to Buffer
      });
      jsonResult[entry.name] = pdataObj;
    } else {
      if ((header.dest && header.dest === 32) || header.from === "Android") {
        break; // ignore those ping messages
      }
      log(
        `Unknown cmdId: ${header.cmdId} cmdFunc: ${header.cmdFunc} for device: ${sn}`
      );
      log(JSON.stringify(message));
    }
  }
  return jsonResult;
}

function getVarintByteSize(number) {
  // Initialize byteSize to account for the two varint marker bytes.
  let byteSize = 2;

  // Keep looping as long as number is greater than or equal to 128.
  while (number >= 128) {
    // Right shift number by 7 bits.
    number >>= 7;
    // Increase the byteSize for each continuation byte.
    byteSize++;
  }
  return byteSize;
}

const ecoflowDevicePropertiesCatalog = [
  {
    id: 1,
    name: "InverterHeartbeat",
    type: "PS",
    template: "InverterHeartbeat",
    readOnly: true,
    cmdFunc: 20,
  },
  {
    id: 4,
    name: "InverterHeartbeat2",
    type: "PS",
    template: "InverterHeartbeat2",
    readOnly: true,
    cmdFunc: 20,
  },
  {
    id: 11,
    name: "Ping",
    type: "PS",
    template: "setValue",
    readOnly: true,
    cmdFunc: 32,
  },
  {
    id: 32,
    name: "PowerPack_32",
    type: "PS",
    template: "PowerPack32",
    readOnly: true,
    cmdFunc: 254,
  },

  {
    id: 135,
    name: "SetDisplayBrightness",
    type: "PS",
    template: "setValue",
    readOnly: false,
    ValueName: "value",
    cmdFunc: 20,
  },
  {
    id: 136,
    name: "PowerPack_136",
    type: "PS",
    template: "PowerPack136",
    readOnly: true,
    cmdFunc: 20,
  },
  {
    id: 138,
    name: "PowerPack_138",
    type: "PS",
    template: "PowerPack138",
    readOnly: true,
    cmdFunc: 20,
  },
  {
    id: 130,
    name: "SetPrio",
    type: "PS",
    template: "setValue",
    readOnly: false,
    cmdFunc: 20,
  },
  {
    id: 132,
    name: "SetBatLimitLow",
    type: "PS",
    template: "setValue",
    readOnly: false,
    cmdFunc: 20,
  },
  {
    id: 133,
    name: "SetBatLimitHigh",
    type: "PS",
    template: "setValue",
    readOnly: false,
    cmdFunc: 20,
  },
  {
    id: 129,
    name: "SetAC",
    type: "PS",
    template: "setValue",
    readOnly: false,
    cmdFunc: 20,
  },
];

const protoSource = `
syntax = "proto3";
message Message {
 repeated Header header = 1 ;
 bytes payload = 2;
}
message Header {
  bytes pdata = 1 [proto3_optional = false];
  int32 src = 2 [proto3_optional = true];
  int32 dest = 3 [proto3_optional = true];
  int32 d_src = 4 [proto3_optional = true];
  int32 d_dest = 5 [proto3_optional = true];
  int32 enc_type = 6 [proto3_optional = true];
  int32 check_type = 7 [proto3_optional = true];
  int32 cmd_func = 8 [proto3_optional = true];
  int32 cmd_id = 9 [proto3_optional = true];
  int32 data_len = 10 [proto3_optional = true];
  int32 need_ack = 11 [proto3_optional = true];
  int32 is_ack = 12 [proto3_optional = true];
  int32 seq = 14 [proto3_optional = true];
  int32 product_id = 15 [proto3_optional = true];
  int32 version = 16 [proto3_optional = true];
  int32 payload_ver = 17 [proto3_optional = true];
  int32 time_snap = 18 [proto3_optional = true];
  int32 is_rw_cmd = 19 [proto3_optional = true];
  int32 is_queue = 20 [proto3_optional = true];
  int32 ack_type = 21 [proto3_optional = true];
  string code = 22 [proto3_optional = true];
  string from = 23 [proto3_optional = true];
  string module_sn = 24 [proto3_optional = true];
  string device_sn = 25 [proto3_optional = true];
}
message InverterHeartbeat {
  optional uint32 inv_err_code = 1;
  optional uint32 inv_warn_code = 3;
  optional uint32 pv1_err_code = 2;
  optional uint32 pv1_warn_code = 4;
  optional uint32 pv2_err_code = 5;
  optional uint32 pv2_warning_code = 6;
  optional uint32 bat_err_code = 7;
  optional uint32 bat_warning_code = 8;
  optional uint32 llc_err_code = 9;
  optional uint32 llc_warning_code = 10;
  optional uint32 pv1_statue = 11;
  optional uint32 pv2_statue = 12;
  optional uint32 bat_statue = 13;
  optional uint32 llc_statue = 14;
  optional uint32 inv_statue = 15;
  optional int32 pv1_input_volt = 16;
  optional int32 pv1_op_volt = 17;
  optional int32 pv1_input_cur = 18;
  optional int32 pv1_input_watts = 19;
  optional int32 pv1_temp = 20;
  optional int32 pv2_input_volt = 21;
  optional int32 pv2_op_volt = 22;
  optional int32 pv2_input_cur = 23;
  optional int32 pv2_input_watts = 24;
  optional int32 pv2_temp = 25;
  optional int32 bat_input_volt = 26;
  optional int32 bat_op_volt = 27;
  optional int32 bat_input_cur = 28;
  optional int32 bat_input_watts = 29;
  optional int32 bat_temp = 30;
  optional uint32 bat_soc = 31;
  optional int32 llc_input_volt = 32;
  optional int32 llc_op_volt = 33;
  optional int32 llc_temp = 34;
  optional int32 inv_input_volt = 35;
  optional int32 inv_op_volt = 36;
  optional int32 inv_output_cur = 37;
  optional int32 inv_output_watts = 38;
  optional int32 inv_temp = 39;
  optional int32 inv_freq = 40;
  optional int32 inv_dc_cur = 41;
  optional int32 bp_type = 42;
  optional int32 inv_relay_status = 43;
  optional int32 pv1_relay_status = 44;
  optional int32 pv2_relay_status = 45;
  optional uint32 install_country = 46;
  optional uint32 install_town = 47;
  optional uint32 permanent_watts = 48;
  optional uint32 dynamic_watts = 49;
  optional uint32 supply_priority = 50;
  optional uint32 lower_limit = 51;
  optional uint32 upper_limit = 52;
  optional uint32 inv_on_off = 53;
  optional uint32 wireless_err_code = 54;
  optional uint32 wireless_warn_code = 55;
  optional uint32 inv_brightness = 56;
  optional uint32 heartbeat_frequency = 57;
  optional uint32 rated_power = 58;
}
message InverterHeartbeat2 {
   int32 X_Unknown_1 = 1;
   int32 X_Unknown_2 = 2;
   int32 X_Unknown_3 = 3;
   int32 X_Unknown_4 = 4;
   int32 X_Unknown_5 = 5;
   int32 X_Unknown_6 = 6;
   int32 X_Unknown_7 = 7;
   int32 X_Unknown_8 = 8;
   int32 X_Unknown_9 = 9;
   int32 X_Unknown_10 = 10;
   int32 X_Unknown_11 = 11;
   int32 X_Unknown_12 = 12;
   int32 X_Unknown_13 = 13;
   int32 X_Unknown_14 = 14;
   int32 X_Unknown_15 = 15;
   int32 X_Unknown_16 = 16;
   int32 X_Unknown_17 = 17;
   int32 X_Unknown_18 = 18;
   int32 X_Unknown_19 = 19;
   int32 X_Unknown_20 = 20;
   int32 X_Unknown_21 = 21;
   int32 X_Unknown_22 = 22;
   int32 X_Unknown_23 = 23;
   int32 X_Unknown_24 = 24;
   int32 X_Unknown_25 = 25;
   int32 X_Unknown_26 = 26;
   int32 X_Unknown_27 = 27;
   int32 X_Unknown_28 = 28;
   int32 X_Unknown_29 = 29;
   int32 X_Unknown_30 = 30;
   int32 X_Unknown_31 = 31;
   int32 X_Unknown_32 = 32;
   int32 X_Unknown_33 = 33;
   int32 X_Unknown_34 = 34;
   int32 X_Unknown_35 = 35;
   int32 X_Unknown_36 = 36;
   int32 X_Unknown_37 = 37;
   int32 X_Unknown_38 = 38;
   int32 X_Unknown_39 = 39;
   int32 X_Unknown_40 = 40;
   int32 X_Unknown_41 = 41;
   int32 X_Unknown_42 = 42;
   int32 X_Unknown_43 = 43;
   int32 X_Unknown_44 = 44;
   int32 X_Unknown_45 = 45;
   int32 X_Unknown_46 = 46;
   int32 X_Unknown_47 = 47;
   int32 X_Unknown_48 = 48;
   int32 X_Unknown_49 = 49;
   int32 X_Unknown_50 = 50;
   int32 X_Unknown_51 = 51;
   int32 X_Unknown_52 = 52;
}
message setMessage {
 setHeader header = 1;
}
message setHeader {
  setValue pdata = 1 [proto3_optional = true];
  int32 src = 2 [proto3_optional = true];
  int32 dest = 3 [proto3_optional = true];
  int32 d_src = 4 [proto3_optional = true];
  int32 d_dest = 5 [proto3_optional = true];
  int32 enc_type = 6 [proto3_optional = true];
  int32 check_type = 7 [proto3_optional = true];
  int32 cmd_func = 8 [proto3_optional = true];
  int32 cmd_id = 9 [proto3_optional = true];
  int32 data_len = 10 [proto3_optional = true];
  int32 need_ack = 11 [proto3_optional = true];
  int32 is_ack = 12 [proto3_optional = true];
  int32 seq = 14 [proto3_optional = true];
  int32 product_id = 15 [proto3_optional = true];
  int32 version = 16 [proto3_optional = true];
  int32 payload_ver = 17 [proto3_optional = true];
  int32 time_snap = 18 [proto3_optional = true];
  int32 is_rw_cmd = 19 [proto3_optional = true];
  int32 is_queue = 20 [proto3_optional = true];
  int32 ack_type = 21 [proto3_optional = true];
  string code = 22 [proto3_optional = true];
  string from = 23 [proto3_optional = true];
  string module_sn = 24 [proto3_optional = true];
  string device_sn = 25 [proto3_optional = true];
}
message setValue {
  optional int32 value = 1;
}
message permanent_watts_pack {
  optional int32 permanent_watts = 1;
}
message supply_priority_pack {
  optional int32 supply_priority = 1;
}
message bat_lower_pack {
  optional int32 lower_limit = 1;
}
message bat_upper_pack {
  optional int32 upper_limit = 1;
}
message PowerItem {
  optional uint32 timestamp = 1;
  optional sint32 timezone = 2;
  optional uint32 inv_to_grid_power = 3;
  optional uint32 inv_to_plug_power = 4;
  optional int32 battery_power = 5;
  optional uint32 pv1_output_power = 6;
  optional uint32 pv2_output_power = 7;
}
message PowerPack2 {
  optional uint32 sys_seq = 1;
  repeated PowerItem EnergyItem = 2;
}
message PowerPack32 {
  optional uint32 sys_seq = 1;
  repeated EnergyItem EnergyItem = 2;
}
message PowerPack133 {
  optional uint32 sys_seq = 1;
  repeated EnergyItem EnergyItem = 2;
}
message PowerPack138 {
  optional uint32 sys_seq = 1;
  repeated PowerItem EnergyItem = 2;
}
message PowerPack135 {
  optional uint32 sys_seq = 1;
  repeated PowerItem EnergyItem = 2;
}
message PowerPack136 {
  optional uint32 sys_seq = 1;
  repeated PowerItem EnergyItem = 2;
}
message PowerPack {
  optional uint32 sys_seq = 1;
  repeated PowerItem sys_power_stream = 2;
}
message PowerAckPack {
  optional uint32 sys_seq = 1;
}
message node_massage {
  optional string sn = 1;
  optional bytes mac = 2;
}
message mesh_child_node_info {
  optional uint32 topology_type = 1;
  optional uint32 mesh_protocol = 2;
  optional uint32 max_sub_device_num = 3;
  optional bytes parent_mac_id = 4;
  optional bytes mesh_id = 5;
  repeated node_massage sub_device_list = 6;
}
message EnergyItem {
  optional uint32 timestamp = 1;
  optional uint32 watth_type = 2;
  repeated uint32 watth = 3;
}
message EnergyTotalReport {
  optional uint32 watth_seq = 1;
  optional EnergyItem watth_item = 2;
}
message BatchEnergyTotalReport {
  optional uint32 watth_seq = 1;
  repeated EnergyItem watth_item = 2;
}
message EnergyTotalReportAck {
  optional uint32 result = 1;
  optional uint32 watth_seq = 2;
  optional uint32 watth_type = 3;
}
message EventRecordItem {
  optional uint32 timestamp = 1;
  optional uint32 sys_ms = 2;
  optional uint32 event_no = 3;
  repeated float event_detail = 4;
}
message EventRecordReport {
  optional uint32 event_ver = 1;
  optional uint32 event_seq = 2;
  repeated EventRecordItem event_item = 3;
}
message EventInfoReportAck {
  optional uint32 result = 1;
  optional uint32 event_seq = 2;
  optional uint32 event_item_num = 3;
}
message ProductNameSet {
  optional string name = 1;
}
message ProductNameSetAck {
  optional uint32 result = 1;
}
message ProductNameGet {}
message ProductNameGetAck {
  optional string name = 3;
}
message RTCTimeGet {}
message RTCTimeGetAck {
  optional uint32 timestamp = 1;
  optional int32 timezone = 2;
}
message RTCTimeSet {
  optional uint32 timestamp = 1;
  optional int32 timezone = 2 [(nanopb).default = 0];
}
message RTCTimeSetAck {
  optional uint32 result = 1;
}
message country_town_message {
  optional uint32 country = 1;
  optional uint32 town = 2;
}
message time_task_config {
  optional uint32 task_index = 1;
  optional time_range_strategy time_range = 2;
  optional uint32 type = 3;
}
message time_task_delet {
  optional uint32 task_index = 1;
}
message time_task_config_post {
  optional time_task_config task1 = 1;
  optional time_task_config task2 = 2;
  optional time_task_config task3 = 3;
  optional time_task_config task4 = 4;
  optional time_task_config task5 = 5;
  optional time_task_config task6 = 6;
  optional time_task_config task7 = 7;
  optional time_task_config task8 = 8;
  optional time_task_config task9 = 9;
  optional time_task_config task10 = 10;
  optional time_task_config task11 = 11;
}
message time_task_config_ack {
  optional uint32 task_info = 1;
}
message rtc_data {
  optional int32 week = 1 [(nanopb).default = 0];
  optional int32 sec = 2 [(nanopb).default = 0];
  optional int32 min = 3 [(nanopb).default = 0];
  optional int32 hour = 4 [(nanopb).default = 0];
  optional int32 day = 5 [(nanopb).default = 0];
  optional int32 month = 6 [(nanopb).default = 0];
  optional int32 year = 7 [(nanopb).default = 0];
}
message time_range_strategy {
  optional bool is_config = 1;
  optional bool is_enable = 2;
  optional int32 time_mode = 3;
  optional int32 time_data = 4;
  optional rtc_data start_time = 5;
  optional rtc_data stop_time = 6;
}
message plug_ack_message {
  optional uint32 ack = 1;
}
message plug_heartbeat_pack {
  optional uint32 err_code = 1 [(nanopb).default = 0];
  optional uint32 warn_code = 2 [(nanopb).default = 0];
  optional uint32 country = 3 [(nanopb).default = 0];
  optional uint32 town = 4 [(nanopb).default = 0];
  optional int32 max_cur = 5 [(nanopb).default = 0];
  optional int32 temp = 6 [(nanopb).default = 0];
  optional int32 freq = 7 [(nanopb).default = 0];
  optional int32 current = 8 [(nanopb).default = 0];
  optional int32 volt = 9 [(nanopb).default = 0];
  optional int32 watts = 10 [(nanopb).default = 0];
  optional bool switch = 11 [(nanopb).default = false];
  optional int32 brightness = 12 [(nanopb).default = 0];
  optional int32 max_watts = 13 [(nanopb).default = 0];
  optional int32 heartbeat_frequency = 14 [(nanopb).default = 0];
  optional int32 mesh_enable = 15 [(nanopb).default = 0];
}
message plug_switch_message {
  optional uint32 plug_switch = 1;
}
message brightness_pack {
  optional int32 brightness = 1 [(nanopb).default = 0];
}
message max_cur_pack {
  optional int32 max_cur = 1 [(nanopb).default = 0];
}
message max_watts_pack {
  optional int32 max_watts = 1 [(nanopb).default = 0];
}
message mesh_ctrl_pack {
  optional uint32 mesh_enable = 1 [(nanopb).default = 0];
}
message ret_pack {
  optional bool ret_sta = 1 [(nanopb).default = false];
}
enum CmdFunction {
    Unknown = 0;
    PermanentWattsPack = 129;
    SupplyPriorityPack = 130;
}
`;
/**
 * =============================================================================
 * End of Authentication and MQTT Connection Setup
 * =============================================================================
 * You have reached the end of the configuration and code responsible for the
 * authentication and MQTT connection management with the Ecoflow server.
 * =============================================================================
 */

