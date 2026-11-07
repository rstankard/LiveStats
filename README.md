# espn-statcrew

An on-demand "HIT ME" button that pulls a live ESPN college-football boxscore,
reshapes it into **StatCrew-style XML**, and serves it to your Ross XPression
`football statcrew` DataLinq source. Your existing mappings
(`team\player<code=@Key_Stat@>\rush`, row `att`, etc.) work unchanged, because
players are keyed by jersey number (`code` and `uni`).

No install, no admin, no internet dependency beyond the ESPN request itself.

## Files
- `server.js` — the local server + ESPN→StatCrew transform
- `index.html` — the control panel (served at `/`)
- `start.bat` — double-click launcher (Windows)
- `README.md` — this file

## Run it (portable, no admin)

1. **Get portable Node** (one time): download the Windows **.zip** build from
   nodejs.org (e.g. `node-v22.x.x-win-x64.zip`) — the .zip, not the installer.
   Extract it and copy `node.exe` into a `node\` folder next to `server.js`
   (so you have `...\espn-statcrew\node\node.exe`). No admin needed.
   *(If Node is already on the machine's PATH, skip this — start.bat will use it.)*
2. **Double-click `start.bat`.** It opens the control panel in your browser and
   starts the server on port 8089.

To change the port, edit `set PORT=8089` in `start.bat`.

## Use it

1. **Pick the game.** Type the ESPN event id and hit **Load game**, or use
   **Find by date…** to pick from that day's slate. The event id is the number
   in an ESPN game URL (e.g. `.../game/_/gameId/401856686`).
2. **Hit the big button** whenever you want fresh numbers. Each press pulls the
   current boxscore and rewrites the feed. No background polling, so you're
   nowhere near any rate limit.
3. **Or let it run itself.** Pick an interval under the button — Manual, 15s, 30s,
   1m, or 2m. Auto mode keeps writing the feed on that cadence; the manual button
   still works anytime. (You can also default it at launch with `set AUTO=30` in
   `start.bat`.)

## Wire into XPression

Point your `football statcrew` DataLinq source at:

    http://localhost:8089/feed.xml

Run this on the XPression PC and it's a local URL — no firewall between machines.
Prefer a file? Set `OUT_FILE` in `start.bat` (e.g. `set OUT_FILE=%~dp0game.xml`)
and point DataLinq at that path instead.

## What the XML looks like

    <fbgame gameid="401856686" generated="...">
      <status state="in" period="2" clock="0:00" detail="Halftime"/>
      <team vh="V" code="UGA" name="Georgia" score="21">
        <player uni="3" code="3" name="Frazier,Nate" disp="Nate Frazier" gp="1">
          <rush att="10" yds="53" avg="5.3" td="1" long="19"/>
        </player>
        ...
      </team>
      <team vh="H" code="ARK" ...>...</team>
    </fbgame>

Categories covered per player: rushing, passing, receiving, defense, fumbles,
interceptions, returns, kicking, punting. Field names follow StatCrew
conventions (CAR→att, YDS→yds, AVG→avg, TD→td, LONG→long, etc.).

## If a field doesn't line up in XPression

Your XPression StatCrew ITF is the final authority on the exact tag/attribute
names it expects. If a mapping comes back blank, open `server.js` and adjust the
`TAG` and `LABELS` tables near the top — they control every element and
attribute name in the output. (Rushing is the canonical `<rush att=...>`, which
matches what your screenshot showed.)

## Notes
- **Coverage:** FBS and most FCS games are well covered. Small-school/lower
  divisions may have thin or missing boxscores.
- **Latency:** ESPN's boxscore runs ~30s–2min behind the true in-venue feed.
- **Jersey collisions:** CFB allows two players to share a number (one offense,
  one defense). Rare, but keep it in mind since the key is the jersey.
- Node 18+ required (for built-in fetch); any recent portable build is fine.
