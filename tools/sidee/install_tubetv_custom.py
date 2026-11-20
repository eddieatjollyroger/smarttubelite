"""Diagnostic fallback: register TubeTV with a full web-app payload.

Verified on U9 / V0000.09.09F.P0930: this does NOT change the launcher's
HTTP_APP_DEFAULT_URL readback, and a normal StoreType: 99 install works fine.
Keep this only as a diagnostic if a tile truly fails to open. Copy into the
Sidee folder containing sidee.py and run: python3 install_tubetv_custom.py
"""
import json

from core import client

APP_ID = "tubetv"
NAME = "TubeTV"
URL = "https://eddieatjollyroger.github.io/smarttubelite/tools/tile-redirect/index.html"
ICON = "https://eddieatjollyroger.github.io/smarttubelite/tools/tile-redirect/icon.png"

# This firmware's web-app registry uses string store types. If "custom" is
# ignored, try "foxxum" once and inspect the raw record again.
STORE_TYPE = "custom"


def install_payload(app_id, name, url, image=""):
    info = {
        "Id": app_id,
        "AppId": app_id,
        "mediaId": app_id,
        "AppName": name,
        "Title": name,
        "URL": url,
        "StartCommand": url,
        "Type": "Browser",
        "IconURL": image,
        "Icon_96": image,
        "Image": image,
        "Thumb": image,
        "InstallTime": "2026-11-19",
        "RunTimes": 0,
        "StoreType": STORE_TYPE,
        "PreInstall": False,
        "configUrlDownload": 0,
        "configUrl": "",
    }
    return json.dumps({"type": "app_install", "app_info": info})


client.protocol.install_payload = install_payload

s = client.Session.load()
apps = client.add_tile(s, APP_ID, NAME, URL, ICON)
ok = any(client.tile_matches_request(a, APP_ID, URL) for a in apps)

print(("REGISTERED" if ok else "NOT confirmed by TV") + ": " + NAME + " -> " + URL)
print("RAW RECORD:")
for a in apps:
    if str(a.get("appId", "")).lower() == APP_ID:
        print(json.dumps(a, indent=2))
