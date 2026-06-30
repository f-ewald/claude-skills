#!/bin/bash
# Custom status line for GitHub Copilot CLI.
#
# Copilot pipes the current session status as JSON on stdin and renders whatever
# this script prints to stdout. Wire it up via ~/.copilot/settings.json:
#   "statusLine": { "type": "command", "command": "<abs-path>/statusline_copilot.sh", "padding": 0 }
#
# Output format:
#   [<model> (<window> context) · <effort>] <bar> <pct>% | <used>/<window> | ↑<sent> ↓<recv> | <aic> AIC · <quota>% left | <session name>
# e.g.
#   [Opus 4.8 (1M context) · max] ████████░░░░░░░░░░░░ 41% | 406.3k/1m | ↑1.2m ↓45.6k | 536 AIC · 99.5% left | Review README.md for Copilot Alias
#
# The session-name segment is omitted when the session is unnamed (session_name null).
#
# The memory bar reflects current context-window usage and turns yellow at >=60%
# and red at >=80%.
#
# NOTE: This is the Copilot variant (Copilot's status JSON differs from Claude
# Code's). Because this account is on token-based billing, spend is reported as
# AI compute used (AIC = total_nano_aiu / 1e9 — the same value the footer's
# "Session: N AIC used" shows). The "<quota>% left" segment is the remaining
# monthly premium-interaction quota, fetched from `gh api /copilot_internal/user`
# in the background and cached so renders never block on the network.
# The Claude Code variant lives in statusline.sh and is left untouched.

set -u

# ---- Editable settings --------------------------------------------------------
SETTINGS_FILE="${HOME}/.copilot/settings.json"
BAR_WIDTH=20
USE_COLOR=1                                # set to 0 (or export NO_COLOR) to disable ANSI

# Monthly premium-interaction quota (% remaining). Fetched via
# `gh api /copilot_internal/user` in a detached background job and cached, so the
# status line never blocks on the network. Env vars (SL_*) allow testing.
QUOTA_ENABLED="${SL_QUOTA_ENABLED:-1}"     # set to 0 to hide the quota segment
QUOTA_CACHE="${SL_QUOTA_CACHE:-${HOME}/.copilot/.statusline-quota-cache.json}"
QUOTA_TTL_MIN="${SL_QUOTA_TTL_MIN:-5}"     # refresh the cache when older than this many minutes
QUOTA_LOCK="${QUOTA_CACHE}.lock"

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
# AIC        : ai_used.formatted (display) + ai_used.total_nano_aiu (fallback)
# Sent/Recv  : session-cumulative total_input_tokens / total_output_tokens
# Session    : session_name (rightmost segment; omitted when unnamed/null)
IFS=$'\x1f' read -r MODEL_RAW PCT USED WINDOW AIC_FMT NANO_AIU SENT RECV SESSION_NAME <<< "$(
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
      (.ai_used.formatted // ""),
      (.ai_used.total_nano_aiu // 0),
      (.context_window.total_input_tokens // 0),
      (.context_window.total_output_tokens // 0),
      (.session_name // "")
    ] | map(tostring) | join("\u001f")' 2>/dev/null
)"

# Defensive defaults (empty stdin / jq failure / missing fields)
MODEL_RAW="${MODEL_RAW:-unknown}"
PCT="${PCT:-0}"; USED="${USED:-0}"; WINDOW="${WINDOW:-0}"
AIC_FMT="${AIC_FMT:-}"; NANO_AIU="${NANO_AIU:-0}"
SENT="${SENT:-0}"; RECV="${RECV:-0}"
SESSION_NAME="${SESSION_NAME:-}"

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

# ---- AI compute used (AIC = total_nano_aiu / 1e9; matches the footer value) ----
# Prefer Copilot's pre-formatted value; otherwise replicate its formatter (nb()).
if [ -n "$AIC_FMT" ]; then
  AIC="$AIC_FMT"
else
  AIC=$(awk -v n="$NANO_AIU" 'BEGIN{
    a = n / 1e9
    if (a == 0)        { print "0" }
    else if (a >= 100) { printf "%d", a + 0.5 }
    else if (a >= 10)  { s = sprintf("%.1f", a); sub(/\.0$/, "", s); print s }
    else if (a < 0.01) { print "<0.01" }
    else               { s = sprintf("%.2f", a); sub(/0+$/, "", s); sub(/\.$/, "", s); print s }
  }')
fi

# ---- Monthly premium-interaction quota (% remaining) --------------------------
# Display reads a background-refreshed cache so the render never blocks on gh.
QUOTA_PCT=""
if [ "$QUOTA_ENABLED" = "1" ]; then
  if [ -f "$QUOTA_CACHE" ]; then
    QUOTA_PCT=$(jq -r '.quota_snapshots.premium_interactions.percent_remaining // empty' "$QUOTA_CACHE" 2>/dev/null)
  fi
  # Refresh in the background when the cache is missing/stale and gh is available.
  if command -v gh >/dev/null 2>&1 \
     && { [ ! -f "$QUOTA_CACHE" ] || [ -n "$(find "$QUOTA_CACHE" -mmin +"$QUOTA_TTL_MIN" 2>/dev/null)" ]; }; then
    # Clear a stale lock (>1 min) then claim it atomically; skip if already refreshing.
    [ -d "$QUOTA_LOCK" ] && [ -n "$(find "$QUOTA_LOCK" -mmin +1 2>/dev/null)" ] && rmdir "$QUOTA_LOCK" 2>/dev/null
    if mkdir "$QUOTA_LOCK" 2>/dev/null; then
      QUOTA_CACHE="$QUOTA_CACHE" QUOTA_LOCK="$QUOTA_LOCK" nohup sh -c '
        tmp=$(mktemp 2>/dev/null) || { rmdir "$QUOTA_LOCK" 2>/dev/null; exit 0; }
        if gh api /copilot_internal/user >"$tmp" 2>/dev/null \
           && jq -e ".quota_snapshots.premium_interactions.percent_remaining|numbers" "$tmp" >/dev/null 2>&1; then
          mv "$tmp" "$QUOTA_CACHE"
        else
          rm -f "$tmp"
        fi
        rmdir "$QUOTA_LOCK" 2>/dev/null
      ' >/dev/null 2>&1 </dev/null &
    fi
  fi
fi

# Format quota percent (one decimal, strip trailing .0).
QUOTA_FMT=""
if [ -n "$QUOTA_PCT" ]; then
  QUOTA_FMT=$(awk -v p="$QUOTA_PCT" 'BEGIN{ s = sprintf("%.1f", p); sub(/\.0$/, "", s); print s }')
fi

# ---- Model bracket ------------------------------------------------------------
if [ "$(awk -v w="$WINDOW" 'BEGIN{ print (w>0)?1:0 }')" -eq 1 ]; then
  MODEL_SEG="[${MODEL} (${WINDOW_LABEL} context) · ${EFFORT}]"
else
  MODEL_SEG="[${MODEL} · ${EFFORT}]"
fi

# ---- Billing segment: AIC used (+ quota % remaining when available) -----------
if [ -n "$QUOTA_FMT" ]; then
  USAGE_SEG="${AIC} AIC · ${QUOTA_FMT}% left"
else
  USAGE_SEG="${AIC} AIC"
fi

# ---- Session name segment (rightmost; omitted when the session is unnamed) -----
SESSION_SEG=""
if [ -n "$SESSION_NAME" ]; then
  SESSION_SEG=" | ${SESSION_NAME}"
fi

printf '%s %s %s | %s/%s | ↑%s ↓%s | %s%s\n' "$MODEL_SEG" "$BAR" "$PCT_DISP" "$USED_FMT" "$WINDOW_FMT" "$SENT_FMT" "$RECV_FMT" "$USAGE_SEG" "$SESSION_SEG"
