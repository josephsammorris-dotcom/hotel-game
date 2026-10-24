# Hotel

A 3D browser version of the 1986 MB board game **Hotel**: buy land, build hotels, add entrances and leisure
facilities, and bankrupt your rivals when they stay at your hotels. Pass-and-play for 2–4 players, with
computer opponents to fill any seat.

Built with [three.js](https://threejs.org/) and plain JavaScript. The whole game ships as a single
self-contained page, `dist/index.html`, so it can be opened locally or hosted anywhere.

## Playing

Open `dist/index.html` in a modern browser (Chrome, Edge, Safari or Firefox). It needs WebGL2, which every
current phone, tablet and computer has. Progress is saved in the browser after every move.

**Graphics** (Table options → Graphics): *Auto* picks a look to suit the device and adjusts as you play;
*Full*, *Lite* and *Low* fix the look. Table options → Advanced has a frame-rate counter and individual
performance switches for testing.

## Project layout

| Path | What it is |
| --- | --- |
| `src/engine.js` | The rules: a seeded, deterministic game state machine (no graphics) |
| `src/bots.js` | Computer players |
| `src/board-1986.js`, `src/scenery-1986.js` | Board layout, hotel data and scenery placement |
| `src/board3d.js` | The 3D board: models, cars, weather, day/night, fireworks, performance tiers |
| `src/sound.js`, `src/sound-assets.js` | Music and sound effects (recorded samples embedded as data) |
| `src/game.template.html` | The page: interface, game flow, and placeholders the build fills in |
| `build.py` | Inlines everything into `dist/index.html` |
| `tests/tests.js` | Rules tests |
| `tests/sim.js` | Plays thousands of computer-vs-computer games checking the rules never break |

## Building and testing

Needs Python 3 and Node.js.

```sh
python3 build.py          # writes dist/index.html
node tests/tests.js       # rules tests
node tests/sim.js 1000    # 1,000 simulated games
```

Or with npm: `npm run build`, `npm test`.

## Hosting

`wrangler.jsonc` configures Cloudflare Workers to serve `dist/` as a static site. With the repository connected
in Cloudflare (Workers & Pages → Create application → GitHub), every push to `main` is deployed automatically.

## Credits

Sound sources and licences are listed in-game (Table options → Sound credits) and in `src/sound.js`.
Original board game © MB Games, 1986; this is a fan recreation for personal play.
