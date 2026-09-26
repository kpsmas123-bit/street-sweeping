# State of play

Written so a fresh session — or a future me — can resume without re-deriving
anything. Update this when something here stops being true.

Live: https://kpsmas123-bit.github.io/street-sweeping/
Repo: kpsmas123-bit/street-sweeping (public)

## Where the work stands

Three cities live: Berkeley, Oakland, Emeryville.

Done and deployed:

- Berkeley + Oakland street sweeping, both sides per block, verdict per side.
- Emeryville sweeping: one schedule per block covering both sides (the source
  records no sides), with 88 blocks whose week the city does not state.
- Overnight windows (Emeryville sweeps 8pm-5am on 180 routes).
- Berkeley permit areas with rules (753 blocks); Oakland permit zones without
  rules, because Oakland does not publish them (897 blocks).
- Oakland downtown kerb inventory: 2,107 sides carry a kerb regulation (red
  kerb, bus stop, metered with rate, time limit). Downtown only.
- Side inference from GPS offset and heading, always shown as a question.
- A compass "aim the phone the way the car faces" resolver.
- Overhead scene drawn from real street geometry, camera fly-in, a sweeper that
  drives the kerb actually being swept.
- Parked session, live countdown, manual meter/permit limits, walk-back
  directions, NFC entry point, native timer via Shortcuts.
- Two buttons, always: **Drop pin** and **Set timer**. Map and Compass are
  quiet secondaries below them; the calendar export is a footer link, because
  the owner does not use a calendar and said so.
- Drop pin saves where you are now as the car's spot **and drops a labelled pin
  in Apple Maps** (`maps://?ll=<lat>,<lon>&q=<label>` -- `q` beside `ll` is
  Apple's documented way to label a pin rather than run a search). It asks
  first if that would overwrite a spot more than 180 m away, and refuses under
  `?at=`. The save happens before Maps is opened, so it survives either way.
- Set timer carries the deadline when there is one inside a day (Clock will not
  take longer). Otherwise it opens the lengths and asks how long you are
  staying, and the pick becomes the deadline. **iOS Clock has no URL scheme**,
  so Shortcuts is the only route to the real Clock app and the "Set Timer"
  shortcut has to exist on the device; the page cannot detect that it does not,
  so the first two taps say what to do if nothing happens.
- The limit chips (1h/2h/4h) appear only where there is a second clock -- a
  meter, a permit zone, a posted time limit. Elsewhere they are one quiet
  "Set a limit" link, because a sign the data does not have is still a reason
  to want a timer.
- Paid parking, and with it the ParkMobile hand-off, which is now offered only
  where a city says there is something to pay: 2,299 Oakland kerbs with a meter
  standing on them (plus 449 blocks metered but kerb unknown) and 391 Berkeley
  blocks inside a goBerkeley paid area, with its rate and posted limit. Never
  on a red kerb or a bus stop.
- Spatial tiles (one ~22 kB cell per load instead of 5.4 MB), city manifest.
- **Every block ships**, including the ones with no rule at all. See the note in
  `main()`: filtering them out meant the app snapped to a neighbouring street
  and printed its schedule with confidence.
- Each no-sweep block carries the city's own reason -- exempt, uncontrolled,
  highway, outside the city, alleyway, no signage -- instead of one flat
  "exempt".
- A dark map overlay for confirming the block.

## Still outstanding

In rough value order:

1. **More cities.** Emeryville is **done**. Still available, verified:
   - **San Leandro** — `nFaSPZoTjS78xXjw` org. Residential is 16 *zone polygons*
     with a clean `SCHED` string, which does not fit this app's block-and-kerb
     model: there is no street line to draw or snap to. It would need
     centrelines from elsewhere. The commercial layer is 91 polylines and does
     fit, but covers little.
   - **Walnut Creek** — `AhHMUmDoudKVXiUl`, permit parking, 78 polygons, current
     as of 2026-05. Layer id is **1, not 0**. `Restrictions` is free text but
     only 13 distinct values, all parseable.
   Alameda, Albany, Piedmont and Castro Valley were checked and have nothing
   machine-readable — do not re-check those.
2. **More rule types.** Oakland's `Downtown_Parking` (2,558 blockfaces) carries
   time limits, meters, and colour-coded kerbs. Oakland's meters (8,107 points,
   current) and citywide kerb colours (35,174 lines, but surveyed 2005-06 —
   treat as advisory only) are also available.
3. **Holidays.** Berkeley and Oakland end in 2027; **Emeryville has no table at
   all**, and the app now says so on screen. Extend from each city's own
   holidays page, not from parking blogs. The Emeryville table is the most
   valuable of the three to add, because its absence currently disables holiday
   suppression there entirely.
4. **The Cloudflare move.** `_headers` and `_redirects` are committed and ready;
   it needs the owner's account. Gives the app its own origin, which is the only
   real fix for the shared-localStorage problem, and real response headers.
5. **Unverified:** the owner reported being sent to the wrong kerb on Parker St
   and never said what the posted sign read. If the sign disagrees with 2nd
   Wednesday (north) / 2nd Tuesday (south), there is a data bug still open.

## Things that are easy to get wrong

Every one of these was a real bug that shipped:

- **Never state a side the data did not establish.** No default, no auto-place,
  no remembered side restored as confirmed. A guess is rendered as a question
  with a visible confirm.
- Berkeley and Oakland bounding boxes **overlap**; the nearest actual block must
  decide the city, not the first matching box.
- Some blocks have **more than two sides**. The two-kerb picture cannot hold
  them and must not silently drop the rest.
- `k:'?'` (unreadable) is **not** `k:'x'` (not swept).
- Oakland address ranges are often stored **high-to-low**.
- Berkeley's PDF compass letter contradicts its own address ranges on ~4% of
  rows; **address parity wins**.
- The `StreetSweepingRS` layer is **not** a decoder for Oakland's codes.
- Scene rotation is by `+bearing`, not `-bearing`.
- A window whose end is before its start runs past midnight and belongs to the
  day it **starts** on; Oakland's 00:00-03:00 looks similar but does not.
- "1st or 2nd Thursday" is not a date. Keep the block, say what is known.
- A side's compass tag comes from the block's **end-to-end** bearing. Anything
  comparing against a local sub-segment bearing will disagree with it and can
  put both kerbs on the same hand.
- Emeryville's bbox is **inside** Oakland's and they share border streets a
  metre apart, with different schedules. Nearest-block alone cannot separate
  them; the app surfaces both when the margin is inside GPS error.
- Oakland's meter layer holds 8,107 rows and only 4,401 are real: the spares
  sit at 0,0, so anything that does not filter on `POLE_STATU` and a sane
  bounding box drags meters onto blocks at null island.
- A meter near a block is not a meter **on** it. Match on `SUB_AREA`, the street
  the city wrote on the meter (filled on all 4,401), and still ignore the last
  8 m of each end, or a corner meter tags the block round the corner and the
  next block along the same street. Distance alone over-tagged by 58%.
- Oakland's meter inventory still calls International Blvd "E 14th St" -- 147
  meters, the largest single unmatched group. The sweeping data uses the new
  name.
- `NS-UC` is 36% of Oakland's day codes and its domain name is "No Sweeping
  (Uncontrol Condition)" -- the city saying it runs no controlled route there,
  which is not the same claim as "exempt".
- A meter point is on one kerb; a goBerkeley polygon is a neighbourhood up to
  a kilometre across. They cannot be worded the same way.
- Ship filters must not ask only "is it swept" — a permit zone or a kerb
  regulation on an unswept block is still a restriction.

## Running it

    python3 etl/fetch.py && python3 etl/build.py
    python3 -m unittest discover -s etl -t etl

`etl/rpp.py`, `etl/rpp_oakland.py` and `etl/paid.py` are run by hand, not in CI
(the first needs poppler). Bump `?v=` in `index.html` and the asset list plus `CACHE` in
`sw.js` on any deploy that changes the shell.
