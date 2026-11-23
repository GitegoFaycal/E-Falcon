# Hardware verification checklist

Purpose: replace assumptions about the physical chargers with recorded facts. Do this on one unit before relying on the system. Record each answer on the charger's Edit screen in the CMS (Capabilities and Hardware notes).

Nothing here bypasses a safety mechanism. Do not open the cabinet while energised unless you are qualified to; every item below is done from the touchscreen, from documentation, or from the network.

## A. Ask the manufacturer / supplier (Thaisen)

- [ ] Which OCPP version does this firmware implement: 1.6J, 2.0.1, or something else?
- [ ] Is connecting the unit to a third-party OCPP backend permitted and supported? Does it affect warranty or support?
- [ ] Which OCPP 1.6 feature profiles are implemented (Core, Firmware Management, Local Auth List, Reservation, Smart Charging, Remote Trigger)?
- [ ] Can the tariff shown on the "price" screen (four time periods, kWh price, service price, hour price, flat fee) be set remotely? By which mechanism: DataTransfer (vendor ID and message format?), vendor configuration keys, or only through the manufacturer's own platform?
- [ ] Does the firmware support `wss://` (TLS)? Which security profiles (0, 1, 2, 3)? Which root certificates does it trust, and can one be installed?
- [ ] Do A GUN and B GUN have independent power modules, or do they share modules dynamically? What is the per-gun and total rated power?
- [ ] What does the unit do when it loses the backend connection: keep charging, allow new sessions, queue transactions offline?
- [ ] What does "Pre-processing Amount" on the tariff screen mean (pre-authorisation hold?) and what currency/unit do the price fields assume?
- [ ] Current firmware version, and how firmware is updated.
- [ ] Role of the TH-TCU-003 unit versus the main DC controller, and which one runs the OCPP client.

## B. On the touchscreen

- [ ] Photograph every field label on the OCPP screen in full (the current photo is partly washed out).
- [ ] Note the firmware version screen.
- [ ] Confirm the unit's network path: Ethernet, 4G SIM or Wi-Fi, and that it has outbound internet access.
- [ ] Set a **new** authorisation key (the old one appears in a photo).

## C. First connection test

Register the unit in the dashboard first and issue its key (charger page → Connecting this charger). Refused connections appear under Alerts with the reason.

- [ ] Point the unit at the E-Falcon endpoint shown on its charger page. Does it connect over `ws://`? Over `wss://`?
- [ ] Which WebSocket subprotocol does it request (`ocpp1.6`, `ocpp2.0.1`)?
- [ ] Does it send BootNotification? Record vendor, model, serial and firmware strings exactly.
- [ ] Heartbeat interval honoured?
- [ ] StatusNotification for connector 0, 1 and 2? Is connector 1 = A GUN and 2 = B GUN?
- [ ] Run **GetConfiguration** with no keys and save the full reply. Look for `SupportedFeatureProfiles`, `NumberOfConnectors`, meter value keys, and any vendor keys mentioning price, fee or tariff.
- [ ] MeterValues during a session: which measurands, what interval, Wh or kWh?
- [ ] StartTransaction / StopTransaction fields: idTag format, meterStart / meterStop, stop reasons.

## D. Command tests (one at a time, vehicle not connected unless stated)

| Test | Expected | Result | Record as |
|---|---|---|---|
| ChangeAvailability connector 1 → Inoperative | Accepted, then StatusNotification Unavailable; gun refuses to start | | changeAvailability |
| ChangeAvailability connector 1 → Operative | Accepted, then Available | | changeAvailability |
| ChangeAvailability connector 0 (whole unit) | Both guns change | | note |
| ChangeAvailability → Inoperative during a session | "Scheduled"; session continues; applies after it ends | | note |
| Does Inoperative survive a power cycle? | Should persist | | note |
| RemoteStartTransaction (vehicle plugged in) | Accepted, StartTransaction follows | | remoteStartStop |
| RemoteStopTransaction | Accepted, StopTransaction with reason Remote | | remoteStartStop |
| Reset (Soft), no session running | Accepted, reboot, new BootNotification | | reset |
| ChangeConfiguration on a harmless key (e.g. HeartbeatInterval) | Accepted and visible in GetConfiguration | | configuration |
| SetChargingProfile (only if Smart Charging is listed) | Accepted, power limited | | smartCharging |
| Tariff mechanism from section A, if any | Price visible on the touchscreen afterwards | | tariffSync |

For the tariff test, "verified" requires reading the price back on the touchscreen (or through a read command), not just an "Accepted" reply.
