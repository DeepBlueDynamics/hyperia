# Hyperia Bash Integration

hyperia_base64() {
  if command -v base64 >/dev/null 2>&1; then
    printf "%s" "$1" | base64 | tr -d '\n\r'
  elif command -v openssl >/dev/null 2>&1; then
    printf "%s" "$1" | openssl base64 | tr -d '\n\r'
  else
    printf "%s" "$1"
  fi
}

hyperia_preexec() {
  # Avoid running multiple times for a pipeline or prompt command itself
  if [ -n "$COMP_LINE" ]; then
    return
  fi
  if [ "$BASH_SUBSHELL" -gt 0 ]; then
    return
  fi
  if [ "$hyperia_in_preexec" = "1" ] || [ "$BASH_COMMAND" = "hyperia_precmd" ]; then
    return
  fi
  if [ "$HISTCMD" = "$hyperia_last_histcmd" ]; then
    return
  fi
  hyperia_last_histcmd="$HISTCMD"
  hyperia_in_preexec=1

  printf "\033]133;C\007"

  local cmd_line="$BASH_COMMAND"
  local argv0="${cmd_line%% *}"
  local app_path=""
  if [ -n "$argv0" ]; then
    app_path=$(type -P "$argv0" 2>/dev/null)
    if [ -z "$app_path" ]; then
      app_path=$(command -v "$argv0" 2>/dev/null)
    fi
  fi

  local b64_cmd=$(hyperia_base64 "$cmd_line")
  local b64_app=$(hyperia_base64 "$app_path")
  local b64_argv0=$(hyperia_base64 "$argv0")
  local pid=$$

  printf "\033]697;cmd=%s;app=%s;argv0=%s;pid=%s\007" "$b64_cmd" "$b64_app" "$b64_argv0" "$pid"
  
  hyperia_in_preexec=0
}

hyperia_precmd() {
  local exit_status=$?
  printf "\033]133;D;%s\007" "$exit_status"

  if [ -n "$HYPERIA_CTL_DIR" ] && [ -f "$HYPERIA_CTL_DIR/cd" ]; then
    local target_dir=$(cat "$HYPERIA_CTL_DIR/cd")
    rm -f "$HYPERIA_CTL_DIR/cd"
    if [ -d "$target_dir" ]; then
      cd -- "$target_dir"
    fi
  fi

  printf "\033]7;file://localhost%s\007" "$PWD"
  printf "\033]133;A\007"
}

# Trap debug to run preexec
trap 'hyperia_preexec' DEBUG

# Add precmd to PROMPT_COMMAND
if [ -z "$PROMPT_COMMAND" ]; then
  PROMPT_COMMAND="hyperia_precmd"
elif [[ "$PROMPT_COMMAND" != *"hyperia_precmd"* ]]; then
  PROMPT_COMMAND="hyperia_precmd; $PROMPT_COMMAND"
fi

# Insert OSC 133 B to PS1 (prompt end)
if [[ "$PS1" != *"\[\033]133;B\007\]"* ]]; then
  PS1="\[\033]133;B\007\]$PS1"
fi
