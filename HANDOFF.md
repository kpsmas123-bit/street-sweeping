# State of play

Written so a fresh session — or a future me — can resume without re-deriving
anything. Update this when something here stops being true.

Live: https://kpsmas123-bit.github.io/street-sweeping/
Repo: kpsmas123-bit/street-sweeping (public)

## Where the work stands

Done and deployed:

- Berkeley + Oakland street sweeping, both sides per block, verdict per side.
- Berkeley permit areas with rules (753 blocks); Oakland permit zones without
  rules, because Oakland does not publish them (915 blocks).
- Side inference from GPS offset and heading, always shown as a question.
- A compass "aim the phone the way the car faces" resolver.
- Overhead scene drawn from real street geometry, camera fly-in, a sweeper that
  drives the kerb actually being swept.
- Parked session, live countdown, manual meter/permit limits, walk-back
  directions, NFC entry point, native timer via Shortcuts, ParkMobile hand-off.
- Spatial tiles (~30 kB per load instead of 2.6 MB), city manifest.
- A dark map overlay for confirming the block.

## Still outstanding

In rough value order:

1. **More cities.** Research verified working endpoints for Emeryville
   (sweeping with clean coded domains, plus sign legends), San Leandro
   (sweeping zones), and Walnut Creek (permit parking, current). Alameda,
   Albany, Piedmont and Castro Valley were checked and have nothing
   machine-readable — do not re-check those.
2. **More rule types.** Oakland's `Downtown_Parking` (2,558 blockfaces) carries
   time limits, meters, and colour-coded kerbs. Oakland's meters (8,107 points,
   current) and citywide kerb colours (35,174 lines, but surveyed 2005-06 —
   treat as advisory only) are also available.
3. **Holiday tables end in 2027.** The UI warns when coverage is within 60 days
   of running out. Extend from each city's own holidays page, not from blogs.
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

## Running it

    python3 etl/fetch.py && python3 etl/build.py
    python3 -m unittest discover -s etl -t etl

`etl/rpp.py` and `etl/rpp_oakland.py` are run by hand, not in CI (the first
needs poppler). Bump `?v=` in `index.html` and the asset list plus `CACHE` in
`sw.js` on any deploy that changes the shell.
