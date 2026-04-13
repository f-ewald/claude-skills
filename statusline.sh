#!/bin/bash
input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0')
# Actual context usage = input_tokens + cache_creation + cache_read from current_usage
TOKENS=$(echo "$input" | jq -r '
  (.context_window.current_usage.input_tokens // 0) +
  (.context_window.current_usage.cache_creation_input_tokens // 0) +
  (.context_window.current_usage.cache_read_input_tokens // 0)')

# Build a 20-character progress bar
# Each position = 5%. Full block (█) for filled, light shade (░) for empty.
# Half block (▌) when the percentage falls between two full blocks.
FILLED=$(echo "$PCT" | awk '{printf "%d", $1 / 5}')
HALF=$(echo "$PCT $FILLED" | awk '{if (($1 / 5) - $2 >= 0.5) print 1; else print 0}')
EMPTY=$((20 - FILLED - HALF))

BAR=""
for ((i=0; i<FILLED; i++)); do BAR+="█"; done
if [ "$HALF" -eq 1 ]; then BAR+="▌"; fi
for ((i=0; i<EMPTY; i++)); do BAR+="░"; done

# Truncate percentage to integer for display
PCT_INT=$(echo "$PCT" | cut -d. -f1)

# Format token count (e.g., 52500 -> "52.5k", 1200000 -> "1.2m")
TOKENS_FMT=$(echo "$TOKENS" | awk '{
  if ($1 >= 1000000) printf "%.1fm", $1 / 1000000
  else if ($1 >= 1000) printf "%.1fk", $1 / 1000
  else printf "%d", $1
}')

COST_USD=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
COST_DOLLARS=$(echo "$COST_USD" | awk '{printf "%.2f", $1}')

WINDOW=$(echo "$input" | jq -r '.context_window.context_window_size // 0')
WINDOW_FMT=$(echo "$WINDOW" | awk '{
  if ($1 >= 1000000) printf "%.0fm", $1 / 1000000
  else if ($1 >= 1000) printf "%.0fk", $1 / 1000
  else printf "%d", $1
}')

echo "[$MODEL] $BAR ${PCT_INT}% | ${TOKENS_FMT}/${WINDOW_FMT} | \$$COST_DOLLARS"
