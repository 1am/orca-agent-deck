Running several coding agents at once? Agent Deck for Orca puts every agent and terminal pane from Orca on a Stream Deck key, so you see at a glance which one is working, which one has finished and which one is waiting for you. Press a key to jump straight to that pane, without hunting through windows.

Features:
- Pane keys show each pane's state: working, needs input, awaiting reply, done, error or offline
- Press a key to focus that pane in Orca, hold it to assign the current pane (local only)
- An attention key counts the panes that need you and takes you to the most urgent one
- A status key shows setup checks
- Works with local panes and panes on SSH hosts, including tmux (one agent per tmux session)

Requirements:
- Orca 1.4.248 or newer, with the orca shell command registered
- Stream Deck app 7.1 or newer
- macOS 13 or newer, Windows 10 or newer, or Linux (tested on Ubuntu 22.04); pane raising on press works on macOS, and on Linux under X11 with xdotool or wmctrl installed. On Linux, install the release package in OpenDeck.
- The companion Orca plugin, installed separately (setup steps in the plugin's Readme)

Agent Deck for Orca is an independent personal project and is not made by Orca or Elgato.
