#!/bin/bash
# Opens a 16:9 Terminal.app window running the tmux layout. Usage: open-window.sh <project dir>
set -e
RIG="$(cd "$(dirname "$0")" && pwd)"; PROJECT="${1:?project dir}"
tmux -L jevdemo kill-server 2>/dev/null || true
# Never take the keyboard: if Terminal is the app being typed in, wait until it is not.
for i in $(seq 1 120); do
  FRONT=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)
  [ "$FRONT" != "Terminal" ] && break
  perl -e 'select(undef,undef,undef,2)'
done
[ "$FRONT" = "Terminal" ] && { echo "ABORT: Terminal is in use; not opening a window." >&2; exit 9; }
osascript <<OSA
tell application "Terminal"
  repeat with oldWindow in (every window whose name contains "jev-rules demo")
    close oldWindow saving no
  end repeat
  set t to do script "cd '$PROJECT' && clear && exec tmux -L jevdemo -f '$RIG/tmux.conf' new-session -s jevdemo"
  set w to first window whose tabs contains t
  set current settings of t to settings set "Pro"
  set font name of t to "Menlo"
  set font size of t to 17
  set background color of t to {3000, 3500, 5000}
  set bounds of w to {14, 40, 1714, 1028}
  set custom title of t to "jev-rules demo"
  set title displays custom title of t to true
  set title displays device name of t to false
  set title displays shell path of t to false
  set title displays window size of t to false
end tell
tell application "System Events" to set frontmost of (first application process whose name is "$FRONT") to true
OSA
