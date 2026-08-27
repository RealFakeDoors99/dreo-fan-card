# Dreo Fan Card

A custom [Home Assistant](https://www.home-assistant.io/) Lovelace card for controlling a Dreo air circulator. It combines power, speed, preset modes, manual aiming, and oscillation controls in a single card with a visual fan-position display.

> [!IMPORTANT]
> This is an unofficial community project and is not affiliated with or endorsed by Dreo.

## Features

- Power and fan-speed controls
- Fan preset mode selection
- Horizontal and vertical aiming with drag and nudge controls
- Horizontal, vertical, and 3D oscillation modes
- Adjustable oscillation limits
- Remembers the last reported angles while related entities are unavailable during oscillation

## Requirements

- Home Assistant with a Dreo fan integration that exposes the fan, angle, oscillation direction, and oscillation range entities used by the card
- A dashboard that supports custom JavaScript modules

The default entity IDs match the author's setup. You can override every entity ID in the card configuration.

## Installation

1. Copy `dreo-fan-card.js` into your Home Assistant `config/www` directory.
2. In Home Assistant, open **Settings > Dashboards**, open the three-dot menu, and choose **Resources**.
3. Add `/local/dreo-fan-card.js` as a **JavaScript module**.
4. Refresh the browser, then add a manual card to a dashboard.

While developing the card, you can copy both JavaScript files and register `/local/dreo-fan-card-loader.js` instead. The loader bypasses browser caching on each page load. For normal use, load `dreo-fan-card.js` directly.

## Configuration

```yaml
type: custom:dreo-fan-card
entity: fan.air_circulator
name: Air Circulator
horizontal_entity: number.air_circulator_fan_angle_horizontal
vertical_entity: number.air_circulator_fan_angle_vertical
direction_entity: select.air_circulator_oscillation_direction
range_up_entity: number.air_circulator_fan_osc_range_up
range_right_entity: number.air_circulator_fan_osc_range_right
range_down_entity: number.air_circulator_fan_osc_range_down
range_left_entity: number.air_circulator_fan_osc_range_left
```

Only `entity` is required. The other values shown above are the current defaults.

| Option | Purpose | Default |
| --- | --- | --- |
| `entity` | Main Home Assistant fan entity | Required |
| `name` | Card title | `Air Circulator` |
| `horizontal_entity` | Horizontal angle number entity | `number.air_circulator_fan_angle_horizontal` |
| `vertical_entity` | Vertical angle number entity | `number.air_circulator_fan_angle_vertical` |
| `direction_entity` | Oscillation direction select entity | `select.air_circulator_oscillation_direction` |
| `range_up_entity` | Upper vertical sweep limit | `number.air_circulator_fan_osc_range_up` |
| `range_right_entity` | Right horizontal sweep limit | `number.air_circulator_fan_osc_range_right` |
| `range_down_entity` | Lower vertical sweep limit | `number.air_circulator_fan_osc_range_down` |
| `range_left_entity` | Left horizontal sweep limit | `number.air_circulator_fan_osc_range_left` |
| `speed_count` | Override the detected number of fan speeds | `9` when detection is unavailable |
| `command_settle_ms` | Delay between dependent fan commands, in milliseconds | `350` |
| `camera_tilt` | Tilt of the visual fan model, in degrees | `20` |
| `pad_inset` | Padding inside the aiming control | `0.16` |

Your integration's entity names may differ. Use **Developer Tools > States** in Home Assistant to find the corresponding entities.

## Development

There is no build step: the card is a native JavaScript module. After editing it, copy the files to Home Assistant's `config/www` directory and refresh the dashboard. The loader file is intended to make this edit-refresh cycle easier.

Before committing, you can run a syntax check with Node.js:

```sh
node --check dreo-fan-card.js
node --check dreo-fan-card-loader.js
```

## Status

This project is in active development. Its defaults and behavior are designed and tested for the Dreo air circulator I own. Support for other models is not currently planned, but the community is welcome to adapt or extend this project for them. 

