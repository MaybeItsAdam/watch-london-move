# Performance audit

An audit of `backend/` and `frontend/` against the goal of this being one
codebase that runs well as a website, an iOS app and an Android app.

Everything below is either a measurement or a change made in response to one.
Where a number appears, the script that produced it is named — they are all in
[Reproducing the measurements](#reproducing-the-measurements) — and they were
taken on an Apple-silicon laptop, so treat them as a *floor*: the shared vCPU
the backend deploys to and the mid-range Android the app has to hold 30fps on
are both several times slower, and it is on those that a cost stops being a
number in a profile and starts being something a user feels.

The headline: this codebase was already carefully optimised on the axes its
authors had looked at — bytes on the wire, cold-start payload, tile
subscriptions, level-of-detail bands. The costs that were left were the ones
that are invisible in a network panel: **allocation and blocking**. A frame that
allocates 13,000 objects and a poll that stops the event loop for a third of a
second do not show up as bytes, and both were sitting directly in front of the
user.

---

## Fixed in this pass

### 1. The frame no longer copies the fleet — 0.68ms → 0.17ms

`useVehicles` rebuilt the whole fleet as new objects on every animation frame:
`{...vehicle}` — a 25-field spread — plus a fresh `position` array, per vehicle,
per tick. At 6,500 vehicles and 60fps that is ~800,000 short-lived objects a
second whose only purpose is to carry three numbers the next frame overwrites.

The pose fields moved onto `RenderVehicle` and are now written in place
(`useVehicles.ts`, `updateRow`). A frame allocates one array; the objects in it
are the same ones as last frame.

```
before  0.676 ms/frame   (bench-rows.mjs, 6,500 vehicles)
after   0.173 ms/frame   — 3.9x, and effectively zero garbage
```

The contract that makes this safe is written down on the type: a row is valid
only for the frame that wrote it. Anything that keeps a pose across frames —
the info panel, the follow loop — goes through `VehiclesApi.getDisplayed`, which
detaches a copy. The array handed to deck.gl is still fresh each frame on
purpose: deck decides whether to re-upload an attribute by comparing the `data`
reference, so reusing one would freeze the fleet on screen.

### 2. The UI stopped re-rendering 60 times a second

`App` re-renders on every animation frame — that is how interpolation reaches
the map — and it was dragging the entire UI tree with it. `Sidebar` alone can be
several hundred line rows, and every callback it received was an inline arrow
rebuilt on each render, so `React.memo` would not have helped even if it had
been there.

Three changes, together:

- `Sidebar`, `InfoPanel` and `StatusBar` are memoised.
- Every callback prop is a stable `useCallback` in `App`.
- The panels are clocked at **1Hz** rather than at the frame rate. Everything
  they display is measured in whole seconds — a countdown, "updated 12s ago" —
  so `now` was `Date.now()` read during a render that happens sixty times a
  second to print the same string.

`selectedVehicle` moved with it: it was `rows.find(...)`, a linear scan of 6,500
rows every frame to locate one vehicle, and it returned a live row the next
frame would rewrite underneath the panel holding it. It is now a Map lookup on
the 1Hz clock.

Net: per-frame React work is `App`'s own body — the fleet bucketing and the
layer rebuild, both of which genuinely have to happen — and every child bails
out of reconciliation.

### 3. Frame pacing adapts to the device

`TARGET_FPS` was fixed at 30 for `pointer: coarse` and 60 otherwise. That says
what *kind* of device this is and nothing about what it can sustain — a 2019
Android and a current flagship are both coarse-pointer.

The rAF loop in `useVehicles` is now closed-loop on the frame intervals the
browser actually delivers. It learns the display's own period from the shortest
interval it sees (so 60Hz and 120Hz are read on the same scale), counts frames
that ran more than 1.75x that, and steps the tick rate down when a window is
mostly slow — recovering only after several clean windows, so it cannot
oscillate against its own relief. Floor 15fps. Interpolation is time-based, so a
lower rate costs smoothness and nothing else, while a saturated main thread also
costs input latency.

### 4. The backend stops blocking on the bus feed — 107ms → 7ms → nothing to block on

`/Mode/bus/Arrivals?count=-1` was one request covering all ~640 routes, and it
answered with ~80MB of JSON. Read on the main thread that is a single
`JSON.parse` holding the event loop, followed by a reduce over ~120,000 rows —
and for the whole of it nothing else runs. No delta emit, no `/health`, no
WebSocket ping, no HTTP response. Every connected client saw a stall on the same
cadence as the poll.

```
bare JSON.parse, 82MB body        179 ms          (bench-parse.mjs)
```

The fix was a worker thread: the request, the parse and the reduce all moved off
the main thread, and only the few thousand canonical vehicle records crossed
back. Measured against a 25MB stand-in feed with a 10ms heartbeat standing in
for a delta emit:

```
                heartbeats served    worst stall
in process           7 / 14            107 ms      (blocking-test.mjs)
worker thread       23 / 22              7 ms
```

Half the heartbeats were simply never delivered in the in-process run.

**Both the worker and the feed it served are now gone.** The URA migration
below replaced the 80MB body with a ~12MB one, and a parse that no longer blocks
does not need a thread to hide it in — so `bus-feed-worker.js`, the epoch
handshake that kept its stop-index mirror honest, and the `BUS_FEED_WORKER`
switch all came out with it. The measurements stay here because they are the
argument for why the migration was worth doing at all: the worker moved half a
second of stall somewhere else every poll, and the cheaper feed removed it.

That is the general shape of the two fixes. Concurrency hides an expensive
operation; the right feed means not performing it.

### 4b. The bus feed itself gets ~7x cheaper

Buses come from TfL's Countdown/URA interface rather than the Unified API,
because URA lets the caller name the fields it wants instead of returning 22
keys per row. Same predictions — 99.5% of matched (vehicle, stop) pairs agree
exactly — for a fraction of the cost:

```
              wire      parsed     fetch
Unified     8.07 MB    ~90 MB     4-11 s
URA         2.07 MB    ~12 MB      ~1.2 s
```

Measured end to end on the deployment, the poll went from ~49s to ~1.4s. The
Unified bus path has since been deleted rather than kept as a rollback: two
readers for one feed is a second thing to keep correct, and the one being kept
warm was the one nobody would notice breaking. `backend/scripts/ura-probe.js`
re-verifies coverage and agreement against Unified on a daily schedule, which is
the honest price of depending on an interface TfL no longer documents.

### 5. The website is installable

There was a complete, hand-written service worker in `public/sw.js` — offline
shell, precached data, per-build asset pruning — and **no web app manifest**, so
none of it added up to an installable app. Android and desktop Chrome had
nothing to offer an install prompt from; the whole feature amounted to a fast
second visit.

Added: `public/manifest.webmanifest`, the 192/512/maskable icons (generated from
the same roundel by `scripts/generate-icons.mjs`, inset to the Android safe
zone), the iOS `apple-mobile-web-app-*` meta tags that stand in for the manifest
there, and Open Graph tags so the site has a title card when it is shared. All
URLs relative, matching `base: './'`, so the same build still serves a web root,
a subdirectory and the Capacitor WebView.

This is the cheapest platform in the matrix: it makes the existing offline work
reachable as an installed app on Android, Windows, macOS and ChromeOS without
touching a store.

### 6. The `updateTriggers` discipline was doing nothing — and now does

This is the correction that reframes everything below it. The section at the
bottom of this file used to list "the accessor `updateTriggers` discipline in
`layers.ts`" under *What is already right*, on the reasoning that colour and
radius are re-evaluated only when selection or focus changes. The mechanism was
there and the intent was right, but it bought nothing.

deck.gl decides an attribute needs rebuilding in two independent ways. One is
`updateTriggers`. The other is the `data` reference, and it is not a tiebreak:

```js
// @deck.gl/core/lib/layer.js
if (dataChanged) { this.getAttributeManager().invalidateAll() }
```

`invalidateAll` means *every* accessor over *every* row, `updateTriggers`
notwithstanding. And `data` was a new array on every single frame — `bucketFleet`
built six fresh arrays each time it ran, which the comment in `useVehicles`
even defended as necessary ("reusing one array across frames would freeze the
fleet on screen"). It was necessary, given that positions had no other way to
reach the GPU. It also meant `getFillColor`, `getRadius`, `getText`,
`getColor`, `getBackgroundColor` and `getOrientation` ran across the whole
fleet sixty times a second to produce the answers they gave last frame — and
`getFillColor` alone allocated a fresh four-element array per row per frame.

The fix is to make the two mechanisms do different jobs. `bucketFleet` now
reconciles into its buckets: it fills module-level scratch arrays, compares
them against last frame's result by reference, and hands back **the same array**
when the membership is unchanged. Membership only turns over when a payload
lands or a filter moves — a few times a minute, not sixty times a second. Poses
then reach the GPU through one trigger of their own, `positionEpoch`, wired to
`getPosition` and `getOrientation` and nothing else.

```
before  1.024 ms/frame   (bench-frame.mjs, 6,500 vehicles, all accessors)
after   0.449 ms/frame   — 2.3x, and no per-row allocation at all
```

The rows are mutated in place, so "same membership" is a reference check per
row rather than a deep comparison. `bucketFleet`'s contract is pinned by
`src/layers.test.ts` — including the case a length check alone would miss, one
vehicle swapped for another.

### 7. The animation loop left React (F2)

`useVehicles` called `setTick` once per paced frame, which re-rendered `App`,
which rebuilt a `useMemo`, which changed a dependency, which fired an effect,
which called `overlay.setProps`. A full reconciliation and effect schedule per
frame to hand deck.gl an array.

The loop now calls a registered handler directly. `App` subscribes once and
does the bucketing and the layer build inside it, reading React-owned values
(filters, selection, the model builder) from a single ref refreshed on each
render. React renders when something a human can see has changed — a selection,
a filter, the 1Hz panel clock — and not otherwise. The status bar's vehicle
count moved onto that same 1Hz clock rather than being a per-frame value.

### 8. Labels are placed at 4Hz, not 60Hz (F3)

`chooseLabels` ran at full frame rate above zoom 14: a fresh `Map`, an object
per occupied cell, a `[...values()]` materialisation, and — the common case in
central London, not the exception — two `filter().sort().slice()` pairs. It also
recomputed an FNV hash over every in-bounds vehicle's id, every frame, for a
ranking that is deliberately *stable* precisely so labels do not move.

Which vehicles carry a blind is now decided every 250ms, into reused maps and
arrays, and immediately whenever the fleet's membership or the selection
changes. The id hash is memoised. Label *positions* are untouched by the
throttle: the array holds live vehicle objects and the layer's `getPosition`
carries the per-frame epoch, so a blind still tracks its vehicle smoothly.
Returning the same array between placements matters as much as skipping the
work — it is what keeps deck.gl from re-rasterising the label atlas.

### 9. The breadcrumb trail stopped being kept for 6,500 vehicles

`historyRef` held the last 25 raw positions for every vehicle in the fleet,
appending a `[lon, lat]` and then a 25-element `slice` copy per vehicle per
payload. Around 160,000 live arrays, maintained continuously, to serve a panel
that only ever asked about one of them — and then only as a fallback for the
minority of lines with no route geometry.

The trail is now recorded for one vehicle, chosen by `VehiclesApi.trackTrail`
and seeded with where it currently stands. The honest cost: a freshly selected
vehicle draws its trail from the moment it was selected rather than showing 25
points it happened to have banked. Separately, the trail is now redrawn as
points arrive — its effect had no dependency that changed on a payload, so it
had only ever been painted once, at the instant of selection.

### 10. `emitTile` stopped serialising every payload twice (B2)

`Buffer.byteLength(JSON.stringify(payload))` ran on the emit path purely to feed
a bandwidth counter, and socket.io then serialised the same object again. It is
now a structural estimate walking the tuples, with the constants fitted against
a real snapshot rather than guessed:

```
                                  full snapshot, 4,106 vehicles
JSON.stringify + byteLength       2.14 ms
structural estimate               0.02 ms      — 108x, and no garbage
accuracy against JSON.stringify   0.33% over
```

The metric names carry `estimated` now, because this is a model of the encoder
rather than the encoder.

### 11. The backend stopped allocating per vehicle per tick

Two costs, neither previously recorded here:

- **`StateStore.scheduleKey` ran on every vehicle on every emit tick.** A
  `.map().join('>')` — a new array *and* a new string — computed for the whole
  fleet purely to decide whether the schedule had changed, before the comparison
  that usually said it had not. It is now computed once at upsert time, where
  the schedule can actually change, and polls are several times rarer than
  emits.
- **`upsertVehicles` spread a fresh object per vehicle per poll**, even when
  every field was identical to last time. It now merges into the object already
  in the map, which has exactly the same field precedence.

### 12. Operator visibility

This service's one real outage mode is a blocked event loop — §4 is entirely a
story about it — and the poller and the socket fan-out still share a process, so
a stall hits every connected client at once. Nothing measured it. `/health` now
reports `process.eventLoopDelay` (mean, p99, max, via `perf_hooks`, reset per
read) and `process.memory`, plus a `feedStale` boolean so an operator is told
the feed has stopped rather than having to subtract `lastPollAt` from the clock.

Two gaps closed alongside it:

- **`scripts/smoke.js` runs in CI.** It is the only thing that exercises the
  socket wiring, the HTTP routes, the rate limiter's `Retry-After` and the
  `/health` auth gate together — `server.js` has no exports and so no unit
  tests — and it had been sitting in `scripts/` uninvoked. It caught the
  bandwidth-metric rename in this very pass.
- **A boot warning when the cache volume is missing.** Route geometry and the
  stop index checkpoint to `.cache`, which only a Railway dashboard setting can
  make persistent. Without it the service comes up healthy and silently repays a
  multi-minute TfL rebuild on every deploy.

### 13. The frontend has tests, and deck.gl has its own chunk (F4)

There were none; the backend had 116. `vitest` now covers the pure logic added
here — the URL-state codec, the preferences store, and `bucketFleet`'s identity
contract, which is the load-bearing invariant of §6 — and runs in CI.

deck.gl's core and 2D layers moved into their own chunk, on the same argument
maplibre already won: large, independently versioned, needed by every session.
Matched per package rather than by `@deck.gl`, which would drag `mesh-layers`
and `@loaders.gl/gltf` back into the eager graph and undo `model-layers.ts`.

```
before   index 934 KB (279 KB gzip)
after    index 291 KB (95 KB gzip) + deckgl 644 KB (185 KB gzip)
         model-layers unchanged at 247 KB, still lazy
```

### 14. Quality of life

Not performance, but the axis this codebase was weakest on. It persisted
*nothing*: a reload discarded the camera, the filters, the basemap choice and
the selection, replayed the intro fly-in, and there was no way to send anyone a
link to a vehicle or a place.

- **URL state** (`src/url-state.ts`) carries camera, selection, line filter,
  mode filter and basemap, written with `replaceState` on a debounce so a pan
  never touches history. A link that names a camera suppresses the fly-in, the
  same way reduced motion does — arriving elsewhere and then travelling is a
  worse answer to "look at this" than simply being there.
- **Preferences** (`src/prefs.ts`) keep what is personal rather than shareable:
  sidebar, route visibility, whether the legend has been dismissed.
- **Share, geolocate and a legend.** The legend is the first thing that has ever
  explained the colour language, the dot-to-model threshold, the two keyboard
  shortcuts, or that the bus-red scatter is decorative — without which it reads
  as data.
- **A `connecting` connection state.** Every session used to open on a red dot
  reading "Disconnected" for the length of the socket handshake.
- **An empty-map notice**, which distinguishes "your filters hid everything"
  from "you have panned off London".
- **Search acts on the map.** The placeholder had always promised to search a
  line; Enter now shows the top match rather than only filtering the list.
- **Android back** unwinds the legend, then the selection, then the sidebar,
  before leaving the app. With no listener it exited outright from anywhere.
- **Accessibility**: a `role="status"` live region on the connection state,
  `:focus-visible` rings on every control (the browser default is close to
  invisible over a translucent panel on a live map), and the search field raised
  to 16px on coarse pointers, under which iOS zooms the viewport on focus and
  never zooms back.

### 15. The stop index is binary, and the grid is built at build time (D1)

`stops.json` was 2.57MB parsed on the main thread into 33,082 objects and then
re-bucketed into a spatial grid — work that landed during the first zoom to
street level, which is exactly when the user is panning. None of it was
necessary: the data changes a few times a year, so the grid can be built once,
at build time, and shipped.

What ships now is two `Float32Array`s of coordinates, the grid as a sorted cell
table, and one UTF-8 blob each for ids and names. Loading it is a `fetch` and a
header read; objects are materialised only for the stops a query returns, which
above zoom 15 is a couple of hundred rather than thirty-three thousand.

```
JSON parse + 33k objects + grid    10.58 ms
binary header + typed-array views   0.15 ms      — 71x (bench-stops.mjs)
```

Laptop figures, so a floor: the phone this was aimed at is several times slower,
which is where a hundred-millisecond stall becomes a couple of milliseconds.

Two details worth keeping:

- **`stops.json` moved out of `public/`.** It is the *source* the binary is
  built from, not something the app fetches. Left where it was, the build would
  have shipped both formats and this change would have added 2.5MB to the iOS
  and Android binaries rather than removing work from them. Bundled data is
  5.02MB → 3.93MB. The JSON stays in the repo so the binary can be rebuilt
  offline: a format bump should not need a live backend and a multi-minute
  harvest.
- **Cells are computed from the Float32 values, not the float64 inputs.** The
  first implementation filed each stop by its float64 cell and then read back a
  Float32 coordinate, and the two disagree on cell boundaries — 51.51 is
  51.50999999999999 in float64, which floors one cell lower. Stops on a boundary
  were filed in one cell and looked for in its neighbour, and simply never
  appeared. The round-trip test caught it; `stop-index.test.ts` now pins it.

The encoder is a build script and the decoder ships, so the byte layout is
written down twice. `stop-index.test.ts` round-trips them against each other and
then decodes the real committed `stops.bin` — because two tests agreeing with
each other would still both pass if the artefact were stale.

### 16. The line list is windowed (F5)

Several hundred rows, memoised so they stayed off the frame path, but still
built, laid out and painted in full on every keystroke in the search box — on a
phone, where the sidebar is a sheet showing about a dozen of them. Only the
visible slice plus an overscan is rendered now, above a 60-row threshold below
which the machinery costs more than it saves.

The row pitch is declared once in CSS as `--line-row-stride` and read back
through `getComputedStyle`, rather than hardcoded in both places: it differs
between pointer types (44px targets on touch), and a virtualiser that disagrees
with the stylesheet drifts further out of place with every row scrolled past.

### 17. There is a byte budget, and it fails the build (P2)

CI ran lint, typecheck, build, both test suites and a server smoke test, and
none of them noticed a chunk gaining 300KB. Every regression in §13 or §15 was
invisible until someone opened the app on a slow phone, which is nobody on the
team.

`scripts/check-budget.mjs` measures JS and CSS **gzipped**, because that is what
crosses the wire, and `public/data` **raw**, because those files are copied
uncompressed into the app binaries and their size is the store listing's
download size. It also fails when a budgeted chunk *disappears* — a rename that
silently stops checking something is how a budget rots into decoration.

```
deckgl        183.3 / 200.0 kB     index         94.7 / 115.0 kB
maplibre      270.1 / 290.0 kB     model-layers  65.6 /  75.0 kB
eager total   561.8 / 620.0 kB     routes.json  2448 / 2600 kB
                                   stops.bin    1482 / 1600 kB
```

Two bugs found by pointing it at the real build, both in the matcher rather than
the bundle. Stripping a content hash with `-[A-Za-z0-9_-]{8,}$` is greedy across
hyphens and turned `model-layers` into `model`, which matched no budget and then
counted itself into the eager total it exists to stay out of. Excluding `-` from
that class fixed the first case and broke `maplibre-D-iNNwj3`, whose rolldown
hash contains a hyphen of its own. Chunks are matched by their `<name>-` prefix
now — the part we choose in `vite.config.ts`, rather than the part the bundler
generates.

---

## Ranked backlog

Ordered by benefit per unit of risk. F2, F3, F4, F5, B2, P1, P2 and the larger
half of D1 have left this list — see the sections above. Note that P1 turned out to
have been fixed already: the `backdrop-filter` rules were inside
`@media (pointer: coarse)` all along and the entry had simply gone stale.

### D1b — The routes collection is re-tiled on every basemap swap

`installMapLayers` runs `map.addSource('routes', { type: 'geojson', data: routes })`
with the whole 2.45MB collection whenever the style is replaced, so MapLibre
re-tiles all of it on its worker each time.

Deliberately **not** fixed in this pass, and the reasoning matters more than the
item. The obvious fix is `setStyle`'s `transformStyle`, carrying the existing
source across into the incoming style — which is the documented use case for it.
But it only preserves anything on the *diff* path, and the swap currently runs
`{ diff: false }`; and the deck.gl overlay is `interleaved: true`, so it injects
custom layers into the style, and custom layers do not survive serialisation
into a `StyleSpecification`. Making this work means restructuring the overlay
teardown around a diffed swap, which cannot be verified without a browser.

Against that: the swap is already guarded by a URL comparison, so it fires at
dusk, at dawn, and when the user presses Day/Night. It is not on any hot path.
Low frequency, high blast radius if it breaks, untestable from a terminal — so
it stays here, with the hazard written down, until someone can watch it happen.

What *was* done is the prerequisite: `installMapLayers` is now idempotent
(`removeAppStyle`), so a `style.load` that arrives without a preceding teardown
— a diffed update, a recovered failure, a future MapLibre — no longer throws on
`addSource` and leave the map with no vehicle layers at all.

PMTiles remains the tiled endgame for this geometry, and remains a build
pipeline plus a runtime protocol.

### F1 — Binary attributes for deck.gl

Still open, but a good deal less urgent than when it was written: §6 removed the
per-frame re-derivation that was most of its case, and `getPosition` over 6,500
rows is now the only accessor left on the frame path. What remains is deck.gl
walking those rows and rebuilding a `Float32Array` from the results. Passing
binary attributes directly —

```js
data: { length: n, attributes: { getPosition: { value: positions, size: 3 } } }
```

— with `updateRow` writing poses straight into a persistent `Float32Array`
removes the accessor calls and the intermediate array. It is a real refactor:
the buckets become index ranges into one buffer rather than arrays of objects,
and picking needs an index→vehicle map, which does not exist today — the
accessor layers hand back the row object as `info.object` and everything
downstream relies on that. Measure before committing to it.

### B1 — One process is the scaling ceiling

`railway.toml` already documents it: `numReplicas = 1`, "shard rather than
stacking more onto a machine". The poller and the fan-out are the same process,
so there is no way to add gateway capacity without also multiplying the TfL
polling. The shape that scales is one poller publishing canonical state, N
stateless gateways holding sockets, and the socket.io Redis adapter between
them. Worth doing before, not after, the app is in two stores. `/health` now
reports event-loop delay, which is the number that says when this has become
urgent.

## What is already right

Worth recording so it does not get "optimised" later by someone who has not read
the comments:

- **Tile-scoped subscriptions and delta encoding.** A zoomed-in client is sent
  its own cells and nothing else, with full snapshots only as a periodic
  resync. The tuple schema plus per-payload string table is a good format and
  the reasoning behind every field is written down.
- **Lazy 3D.** The glTF loader, `@deck.gl/mesh-layers` and the five meshes are
  behind a dynamic import latched by the camera crossing zoom 13.5. A session
  that stays zoomed out never downloads any of it.
- **The route-path index.** Geometry projected once into local metres in
  `Float32Array`s, arc lengths and per-segment bearings precomputed, lookups
  memoised on the *stop pair* rather than on a vehicle position — which is what
  makes the cache hit rather than thrash. There is no trigonometry on the
  per-frame path at all.
- **The accessor `updateTriggers` discipline** in `layers.ts` — *now* that §6
  has made it real. It is worth knowing why this bullet was wrong for as long as
  it stood: the triggers were correctly written, and were silently overridden
  every frame by deck.gl's `data`-reference check. A mechanism being present is
  not the same as it being reached, and nothing in a network panel or a bundle
  report would ever have shown the difference.
- **`/routes`.** Precompressed brotli and gzip buffers, a strong ETag, an
  immutable `?v=` variant, and server-preference encoding negotiation because
  `req.acceptsEncodings` would otherwise hand a browser 644KB of gzip over
  256KB of brotli.
- **The service worker's refusal to cache basemap tiles.** The reasoning — that
  a bound small enough to be responsible thrashes at a low hit rate while adding
  a cache write to every tile during the exact gestures that are the jank
  budget — is correct, and the same conclusion is easy to get wrong.
- **Self-scheduling polls** rather than `setInterval`, so a slow cycle cannot
  stack on the next one.
- **Per-socket rate limiting.** Every inbound socket event goes through its own
  token bucket, and they are separate buckets rather than one pool so that a
  client panning hard cannot spend its own ability to ask for vehicle details:
  `viewport:set` 40 at 2/s, `vehicles:details` 20 at 2/s (on top of the 50-id
  cap per call), `vehicles:request-full` 4 at 0.1/s because a full snapshot is
  the expensive one. The HTTP routes have the same treatment, priced per route.
  Sat in the backlog above as B3 ("no per-socket rate limiting") long after it
  was built; the buckets are in `rate-limit.js` and wired at every handler.

---

## Reproducing the measurements

The scripts are small and self-contained; they are given here rather than
committed because they are stand-ins, not tests.

| What | How |
| --- | --- |
| Stop index load | Time `JSON.parse` of `data-src/stops.json` plus the 33k object build and grid bucketing, against reading `public/data/stops.bin`'s header and taking typed-array views. |
| Per-frame layer feed | Build a 6,500-entry fleet; time 600 iterations of bucketing plus the accessor passes deck.gl would run, once with a fresh `data` array (so every accessor runs) and once reconciled (so only the pose accessors do). |
| Payload size estimate | Fetch `/snapshot` from a running backend; compare `estimatePayloadBytes` against `Buffer.byteLength(JSON.stringify(payload))` for both accuracy and cost. |
| Per-frame fleet rebuild | Build a 6,500-entry `Map` of vehicle-shaped objects; time 600 iterations of the row rebuild plus `bucketFleet`, once with a `{...v}` copy and once writing in place. |
| Large-body parse cost | `JSON.stringify` 120,000 TfL-arrival-shaped rows (~82MB) and time `JSON.parse` on it. |
| Event-loop blocking | Historical — the worker and the 80MB feed it served are both gone (§4). Served a 25MB stand-in feed from a local `http` server, ran a 10ms `setInterval` heartbeat, and counted how many beats were delivered during the whole-network fetch with the worker on and off. Count the beats — do not measure the gap, because the longest stall's timer fires *after* the promise resolves and `clearInterval` will beat it. |
| URA against Unified | `node backend/scripts/ura-probe.js` — fetches both feeds back to back and reports wire size, parse size, latency, coverage and per-vehicle agreement. This one *is* committed, and runs daily in CI, because it guards a live dependency rather than reproducing a past measurement. |
| Bundle | `npm run build --prefix frontend`. |

For the frontend under real load, the honest tool is Chrome DevTools' performance
panel with 4x CPU throttling, or a physical mid-range Android over `adb`. The
numbers here bound the JS; they say nothing about the GPU, and above zoom 14.5
this app is drawing thousands of PBR scenegraphs.
