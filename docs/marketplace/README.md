# Elgato Marketplace assets

Images for the Maker Console listing. `python3 docs/marketplace/generate.py` rebuilds them from `orca-plugin/images`.

| File | Use | Size |
| --- | --- | --- |
| `app-icon-288.png` | App icon | 288x288 |
| `thumbnail-1920x960.png` | Thumbnail | 1920x960 |
| `gallery-1-overview-1920x960.png` | Gallery 1 | 1920x960 |
| `gallery-2-deck-1920x960.png` | Gallery 2 | 1920x960 |
| `gallery-3-actions-1920x960.png` | Gallery 3 | 1920x960 |

## Optional gallery video

`docs/assets/orca-agent-deck-demo-261107.mp4` is 1920x1080 H.264, 94 s, 157 MB, so it fits the MP4 rule (1920x1080, under 250 MB). It is git-ignored: upload it from the local file. The `-small` copy is 1280x720 and does not qualify.

## Not covered

- The images are rendered key art, not photos or screenshots of a real deck. Add a photo of real hardware if the review asks for one: `docs/assets/stream_deck.jpeg` is only 1210x907, too small to reuse.
- Gallery 2 shows faint edges where the deck art meets the flat background.

## Listing text

`description.md` is the Maker Console description: 959 characters (limit 250 to 1500), and its first paragraph is 269 characters of plain text. The product name "Orca Agent Deck" is 15 characters (limit 30) and has no "Plugin" suffix. Whether the name is free on the Marketplace has not been checked: search the Marketplace before submitting.
