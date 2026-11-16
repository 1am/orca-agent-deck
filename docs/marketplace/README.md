# Elgato Marketplace assets

Images for the Maker Console listing. `python3 docs/marketplace/generate.py` rebuilds them from `orca-plugin/images`.

| File | Use | Size |
| --- | --- | --- |
| `app-icon-288.png` | App icon | 288x288 |
| `thumbnail-1920x960.png` | Thumbnail | 1920x960 |
| `gallery-1-desk-1920x960.png` | Gallery 1, photo of a real deck | 1920x960 |
| `gallery-2-overview-1920x960.png` | Gallery 2 | 1920x960 |
| `gallery-3-deck-1920x960.png` | Gallery 3 | 1920x960 |
| `gallery-4-actions-1920x960.png` | Gallery 4 | 1920x960 |

Maker Console needs at least 3 gallery items (up to 10): PNG at 1920x960, or MP4 at 1920x1080 under 250 MB.

## Optional gallery video

The 0.3.0 demo from the Readme, re-exported at 1920x1080 H.264 (107 s, about 13 MB, padded left and right from its 1236x720 source). Video files are git-ignored: upload it from the local file. Rebuild it with:

```sh
ffmpeg -i demo-1236x720.mp4 \
  -vf "scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:color=0x0e0e10,format=yuv420p" \
  -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 160k -movflags +faststart demo-1920x1080.mp4
```

## Not covered

- Only gallery 1 is a photo. The other images are rendered key art.
- Gallery 3 shows faint edges where the deck art meets the flat background.

## Listing text

`description.md` is the Maker Console description: 1226 characters (limit 250 to 1500), and its first paragraph is 303 characters of plain text. The product name "Agent Deck for Orca" is 19 characters (limit 30) and has no "Plugin" suffix. Whether the name is free on the Marketplace has not been checked: search the Marketplace before submitting.

`release-notes.md` is the release notes field for the first version.

## Maker Console fields

| Step | Field | Value |
| --- | --- | --- |
| 1 Files | Product type | Stream Deck plugin |
| 1 Files | File | `orca-agent-deck-<version>.streamDeckPlugin` from the latest GitHub release |
| 2 Details | Name | Agent Deck for Orca |
| 2 Details | Description | `description.md` |
| 2 Details | Tags | Productivity, developer tools, macOS, Windows (pick the closest from the list Maker Console offers) |
| 2 Details | Pricing | Free |
| 2 Details | Additional links | Source and docs: https://github.com/1am/orca-agent-deck - Install guide: https://github.com/1am/orca-agent-deck/blob/main/docs/install.md - Support: https://github.com/1am/orca-agent-deck/issues - Orca plugin: https://orca.dev/plugins/1am/orca-agent-deck |
| 3 Media | Thumbnail | `thumbnail-1920x960.png` |
| 3 Media | Gallery | `gallery-1` to `gallery-4`, then the video |
| 3 Media | App icon | `app-icon-288.png` |
| 3 Media | Release notes | `release-notes.md` |

No privacy policy link is needed: the plugin collects no personal data and sends nothing off the machine.

Review takes 4 to 10 working days. The plugin needs Orca to do anything, so the reviewer may ask for a demonstration video: the gallery video covers that.

## OpenDeck

`opendeck.md` is the entry for the OpenAction plugin registry, which feeds the OpenDeck plugin store.
