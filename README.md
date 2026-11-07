# espn-statcrew

Pulls a live ESPN college-football boxscore, reshapes it into **StatCrew-style XML**,
and hands it to your Ross XPression `football statcrew` DataLinq source. Your
existing mappings (`team\player<code=@Key_Stat@>\rush`, row `att`, etc.) work
unchanged, because players are keyed by jersey number (`code` and `uni`).

No install, no admin, no dependencies beyond the ESPN request itself.

## Files
- `server.js`: the local server and the ESPN-to-StatCrew transform
- `index.html`: the control panel
- `start.bat`: double-click launcher (Windows)
- `settings.json`: your saved settings. It's created the first time you save in
  the Settings window, so it isn't in the download.
- `README.md`: this file

## First-time setup

1. **Get portable Node** (one time). Download the Windows **.zip** build from
   nodejs.org (for example `node-v22.x.x-win-x64.zip`), not the installer.
   Extract it and copy `node.exe` into a `node\` folder next to `server.js`, so
   you have `...\espn-statcrew\node\node.exe`. No admin needed. If Node is
   already on the PC's PATH, skip this.
2. **Double-click `start.bat`.** The server starts and the control panel opens in
   your browser at `http://localhost:8089`.
3. **Open Settings** (gear button, top right) and set up the output file:
   - Tick **Write the feed to a file**.
   - Click **Browse…** and pick the folder, for example `D:\Data\Football`. The
     Windows folder dialog sometimes opens behind the browser; check the taskbar
     if you don't see it.
   - If the folder doesn't exist yet, click **Create it**.
   - Leave the file name as `livestats.xml` or change it.
   - Copy the **Full path** and paste it into XPression (see below).
   - Click **Save settings**.

That's it. Settings are remembered, so next time just double-click `start.bat`.

## Settings

**Output file.** Turns file output on and off and sets the folder and file name.
The window checks that the folder exists and is writable before you save. If a
write ever fails during a game (a drive gets unplugged, the folder is renamed),
the problem shows in red at the bottom of the control panel.

**When the server starts.**
- *Game*: reload the last game you loaded (the default, handy if the PC restarts
  mid-game), load a specific ESPN event id, or start with no game.
- *Refresh*: the mode the server starts in, from Manual to every 2 minutes. You
  can still change it any time from the buttons under HIT ME.
- *Open this control panel in the browser*: turn off if you'd rather open it yourself.

**Server.** The port the panel and feed URL use (default 8089). Changing it takes
effect immediately and the panel moves to the new address. If XPression reads the
feed URL rather than the file, update the URL there too.

## Use it

1. **Pick the game.** Type the ESPN event id and click **Load game**, or use
   **Find by date…** to pick from that day's slate. The event id is the number in
   an ESPN game URL (for example `.../game/_/gameId/401856686`).
2. **Hit the big button** whenever you want fresh numbers. Each press pulls the
   current boxscore and rewrites the feed.
3. **Or let it run itself.** Pick an interval under the button: Manual, 5s, 15s,
   30s, 1m or 2m. Auto mode keeps writing the feed on that cadence, the countdown
   shows when the next pull is due, and the manual button still works anytime.
   5s matches XPression's own 5-second poll; going faster wouldn't reach air any
   sooner.

## Wire into XPression

**File (recommended).** In the `football statcrew` XML Linq source, set **XML
Filename** to the full path from Settings, keep your **XSLT Filename**
(`CFB-Statcrew-Updater.xslt`), and choose **Poll every 5 seconds**. Polling is
more reliable than the file-change option.

**URL.** Alternatively, point the source at `http://localhost:8089/feed.xml`
(use your port if you changed it). Run this on the XPression PC so it's a local
address.

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
interceptions, returns, kicking and punting. Field names follow StatCrew
conventions (CAR→att, YDS→yds, AVG→avg, TD→td, LONG→long, etc.).

## If a field doesn't line up in XPression

Your XPression StatCrew ITF is the final authority on the exact tag and attribute
names it expects. If a mapping comes back blank, open `server.js` and adjust the
`TAG` and `LABELS` tables near the top; they control every element and attribute
name in the output.

## Advanced: start.bat overrides

Everything is set in the Settings window, but `start.bat` still accepts the old
variables. Uncomment a line to force a value; it overrides the saved setting and
the Settings window shows that field as locked by start.bat.

    set PORT=8089
    set OUT_FILE=D:\Data\Football\livestats.xml
    set EVENT_ID=401856686
    set AUTO=30            (seconds)

Don't wrap values in quotes: `set OUT_FILE="D:\..."` makes the quotes part of the
value in Windows.

To start over, close the server and delete `settings.json`.

## Notes
- **Settings are local-only.** The settings and folder features only answer the
  browser on the same PC; other machines on the network can still read
  `/feed.xml`.
- **Coverage:** FBS and most FCS games are well covered. Small-school and
  lower-division boxscores can be thin or missing.
- **Latency:** ESPN's boxscore runs about 30 seconds to 2 minutes behind the
  in-venue feed.
- **Jersey collisions:** CFB allows two players to share a number (one offense,
  one defense). Rare, but keep it in mind since the key is the jersey.
- **Shutting down:** close the console window. Node 18 or newer is required.