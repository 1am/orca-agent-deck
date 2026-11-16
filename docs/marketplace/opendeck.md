# OpenDeck plugin store listing

The OpenDeck plugin store reads the [OpenAction plugin registry](https://github.com/OpenActionAPI/plugins). A listing is one pull request there: an entry in `catalogue.json` and an icon. The registry has no long description or gallery, so the copy is the name, the author and one line.

## Before the pull request

The registry checks these automatically, so set them first:

- Add the `openaction` topic to this repository on GitHub.
- Set this repository's GitHub description (the sidebar "About" text) to the line below. The registry requires its `description` to match it exactly.
- The latest GitHub release must carry the `.streamDeckPlugin` file.

## Description

One line, used both as the GitHub repository description and as the registry `description`:

```text
See which Orca agent needs you: every pane on a Stream Deck key, one press to focus it
```

## Catalogue entry

Add it to the "Open-source Stream Deck plugins" section of `catalogue.json`. Entries in a section are sorted alphabetically by repository URL. `name` and `author` must match `packages/streamdeck-plugin/pl.1am.orca-agent-deck.sdPlugin/manifest.json`.

```json
"pl.1am.orca-agent-deck": {
	"name": "Agent Deck for Orca",
	"author": "1am",
	"repository": "https://github.com/1am/orca-agent-deck",
	"description": "See which Orca agent needs you: every pane on a Stream Deck key, one press to focus it",
	"flags": {
		"ai_assisted": true
	}
}
```

The registry asks for `"ai_assisted": true` when a plugin was built with AI assistance. Drop the `flags` object only if that does not apply.

## Icon

Copy `packages/streamdeck-plugin/pl.1am.orca-agent-deck.sdPlugin/imgs/plugin@2x.png` (or the largest plugin icon available) to `icons/pl.1am.orca-agent-deck.png` in the registry. A maintainer formats it during review.
