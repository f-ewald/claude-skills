#!/bin/bash
# Custom status line for GitHub Copilot CLI.
#
# Copilot pipes the current session status as JSON on stdin and renders whatever
# this script prints to stdout. Wire it up via ~/.copilot/settings.json:
#   "statusLine": { "type": "command", "command": "<abs-path>/statusline_copilot.sh", "padding": 0 }
#
# Output format:
#   [<model> (<window> context) · <effort>] <bar> <pct>% | <used>/<window> | $<cost>
# e.g.
#   [Opus 4.8 (1M context) · max] ████████░░░░░░░░░░░░ 41% | 406.3k/1m | $29.88
#
# The memory bar reflects current context-window usage and turns yellow at >=60%
# and red at >=80%.
#
# NOTE: This is the Copilot variant. Copilot's status JSON differs from Claude
# Code's: there is NO cost.total_cost_usd field, so spend is estimated from
# premium-request count. The Claude Code variant lives in statusline.sh and is
# left untouched.

set -u

# ---- Editable settings --------------------------------------------------------
PREMIUM_REQUEST_USD="0.04"                 # GitHub premium-request overage rate (USD)
SETTINGS_FILE="${HOME}/.copilot/settings.json"
BAR_WIDTH=20
USE_COLOR=1                                # set to 0 (or export NO_COLOR) to disable ANSI

# ANSI color codes (filled bar + percentage)
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_RED=$'\033[31m'
C_RESET=$'\033[0m'
if [ -n "${NO_COLOR:-}" ] || [ "$USE_COLOR" != "1" ]; then
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi
# -------------------------------------------------------------------------------

input=$(cat)

# ---- Parse the fields we need in a single jq pass -----------------------------
# Percentage : current context % -> used_percentage -> 0
# Used tokens: current_context_tokens -> last_call(in+out) -> 0
# Window     : displayed_context_limit -> context_window_size -> 0
# Sent/Recv  : session-cumulative total_input_tokens / total_output_tokens
IFS=$'\t' read -r MODEL_RAW PCT USED WINDOW PREMIUM SENT RECV <<< "$(
  printf '%s' "$input" | jq -r '
    [
      (.model.display_name // "unknown"),
      (.context_window.current_context_used_percentage
         // .context_window.used_percentage // 0),
      (.context_window.current_context_tokens
         // ((.context_window.last_call_input_tokens // 0)
              + (.context_window.last_call_output_tokens // 0))),
      (.context_window.displayed_context_limit
         // .context_window.context_window_size // 0),
      (.cost.total_premium_requests // 0),
      (.context_window.total_input_tokens // 0),
      (.context_window.total_output_tokens // 0)
    ] | @tsv' 2>/dev/null
)"

# Defensive defaults (empty stdin / jq failure / missing fields)
MODEL_RAW="${MODEL_RAW:-unknown}"
PCT="${PCT:-0}"; USED="${USED:-0}"; WINDOW="${WINDOW:-0}"; PREMIUM="${PREMIUM:-0}"
SENT="${SENT:-0}"; RECV="${RECV:-0}"

# Effort is NOT in the stdin feed; read the persisted setting.
EFFORT="default"
if [ -f "$SETTINGS_FILE" ]; then
  EFFORT="$(jq -r '.effortLevel // "default"' "$SETTINGS_FILE" 2>/dev/null || echo default)"
  [ -z "$EFFORT" ] && EFFORT="default"
fi

# Strip a leading "Claude " so "Claude Opus 4.8" renders as "Opus 4.8".
MODEL="${MODEL_RAW#Claude }"

# ---- Percentage + bar ---------------------------------------------------------
PCT_INT=$(awk -v p="$PCT" 'BEGIN{ if(p<0)p=0; if(p>100)p=100; printf "%d", p+0.5 }')

FILLED=$(awk -v p="$PCT_INT" -v w="$BAR_WIDTH" 'BEGIN{ printf "%d", (p/100)*w }')
HALF=$(awk -v p="$PCT_INT" -v w="$BAR_WIDTH" -v f="$FILLED" 'BEGIN{ if ((p/100)*w - f >= 0.5) print 1; else print 0 }')
EMPTY=$((BAR_WIDTH - FILLED - HALF))
[ "$EMPTY" -lt 0 ] && EMPTY=0

if   [ "$PCT_INT" -ge 80 ]; then COLOR="$C_RED"
elif [ "$PCT_INT" -ge 60 ]; then COLOR="$C_YELLOW"
else COLOR="$C_GREEN"; fi

BAR=""
for ((i=0; i<FILLED; i++)); do BAR+="█"; done
[ "$HALF" -eq 1 ] && BAR+="▌"
for ((i=0; i<EMPTY; i++)); do BAR+="░"; done
BAR="${COLOR}${BAR}${C_RESET}"
PCT_DISP="${COLOR}${PCT_INT}%${C_RESET}"

# ---- Token + window formatting ------------------------------------------------
# Format a token count with k/m suffix, one decimal (e.g. 406300 -> 406.3k).
fmt_tokens() {
  awk -v n="$1" 'BEGIN{
    if (n >= 1000000) printf "%.1fm", n/1000000
    else if (n >= 1000) printf "%.1fk", n/1000
    else printf "%d", n
  }'
}

USED_FMT=$(fmt_tokens "$USED")
SENT_FMT=$(fmt_tokens "$SENT")   # session-cumulative input tokens (sent)
RECV_FMT=$(fmt_tokens "$RECV")   # session-cumulative output tokens (received)
WINDOW_FMT=$(awk -v n="$WINDOW" 'BEGIN{
  if (n >= 1000000) printf "%.0fm", n/1000000
  else if (n >= 1000) printf "%.0fk", n/1000
  else printf "%d", n
}')

# Window label for the model bracket (uppercase, e.g. "1M", "200K").
WINDOW_LABEL=$(awk -v w="$WINDOW" 'BEGIN{
  if (w >= 1000000)   { v=w/1000000; if (v==int(v)) printf "%dM", v; else printf "%.1fM", v }
  else if (w >= 1000) { v=w/1000;    if (v==int(v)) printf "%dK", v; else printf "%.0fK", v }
  else printf "%d", w
}')

# ---- Spend (Copilot has no $ field: estimate from premium requests) -----------
COST=$(awk -v r="$PREMIUM" -v u="$PREMIUM_REQUEST_USD" 'BEGIN{ printf "%.2f", r*u }')
# Premium-request count shown in parentheses after the cost (%g drops trailing zeros).
PREMIUM_FMT=$(awk -v r="$PREMIUM" 'BEGIN{ printf "%g", r+0 }')

# ---- Model bracket ------------------------------------------------------------
if [ "$(awk -v w="$WINDOW" 'BEGIN{ print (w>0)?1:0 }')" -eq 1 ]; then
  MODEL_SEG="[${MODEL} (${WINDOW_LABEL} context) · ${EFFORT}]"
else
  MODEL_SEG="[${MODEL} · ${EFFORT}]"
fi

printf '%s %s %s | %s/%s | ↑%s ↓%s | $%s (%s)\n' "$MODEL_SEG" "$BAR" "$PCT_DISP" "$USED_FMT" "$WINDOW_FMT" "$SENT_FMT" "$RECV_FMT" "$COST" "$PREMIUM_FMT"
