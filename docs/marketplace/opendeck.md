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

Add it as the first entry of the "Native OpenAction plugins" section of `catalogue.json`, just before `com.ags.info_clock`. Only maintainers may add to the "Open-source Stream Deck plugins" section: the automatic check rejects anyone else there. A maintainer can move the entry during review. Entries in a section are sorted by repository URL, ignoring case, and `https://github.com/1am/...` sorts first. `name` and `author` must match `packages/streamdeck-plugin/pl.1am.orca-agent-deck.sdPlugin/manifest.json`.

The file must stay in the registry's exact format: tab-indented, as written by Python's `json.dumps(catalogue, indent="\t", ensure_ascii=False)` plus a trailing newline. Edit it with that call rather than by hand.

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

Copy `packages/streamdeck-plugin/pl.1am.orca-agent-deck.sdPlugin/imgs/plugin@2x.png` (or the largest plugin icon available) to `icons/pl.1am.orca-agent-deck.png` in the registry. It is 512x512 (the check needs at least 144x144). A maintainer formats it during review.

## Pull request

Title: `Add Agent Deck for Orca (pl.1am.orca-agent-deck)`

Body:

```markdown
Adds Agent Deck for Orca: Stream Deck keys that show the state of each agent and terminal pane in [Orca](https://orca.dev) and focus the pane when pressed.

- Repository: https://github.com/1am/orca-agent-deck (MIT)
- Built on the Elgato Stream Deck SDK and tested on OpenDeck under Linux (Ubuntu 22.04). The latest release carries the `.streamDeckPlugin` file.
- Placed in the Native section because submissions to the Stream Deck section are maintainer-only. Please move it if it belongs there.
- Built with AI assistance, so `ai_assisted` is set.

Question: the entry points at the repository, so new releases should show up without another pull request. Is that right?
```
