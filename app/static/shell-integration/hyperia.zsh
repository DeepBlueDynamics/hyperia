# Hyperia Zsh Integration

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
  printf "\033]133;C\007"
  
  local cmd_line="$1"
  local argv0="${cmd_line%% *}"
  local app_path=""
  if [[ -n "$argv0" ]]; then
    app_path=$(whence -p "$argv0" 2>/dev/null)
    if [[ -z "$app_path" ]]; then
      app_path=$(command -v "$argv0" 2>/dev/null)
    fi
  fi

  local b64_cmd=$(hyperia_base64 "$cmd_line")
  local b64_app=$(hyperia_base64 "$app_path")
  local b64_argv0=$(hyperia_base64 "$argv0")
  local pid=$$

  printf "\033]697;cmd=%s;app=%s;argv0=%s;pid=%s\007" "$b64_cmd" "$b64_app" "$b64_argv0" "$pid"
}

hyperia_precmd() {
  local exit_status=$?
  printf "\033]133;D;%s\007" "$exit_status"

  if [[ -n "$HYPERIA_CTL_DIR" && -f "$HYPERIA_CTL_DIR/cd" ]]; then
    local target_dir=$(cat "$HYPERIA_CTL_DIR/cd")
    rm -f "$HYPERIA_CTL_DIR/cd"
    if [[ -d "$target_dir" ]]; then
      cd -- "$target_dir"
    fi
  fi

  printf "\033]7;file://localhost%s\007" "$PWD"
  printf "\033]133;A\007"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd hyperia_precmd
add-zsh-hook preexec hyperia_preexec

# Prepend OSC 133 B to the prompt to signal prompt end/command start.
# %{...%} is used to mark non-printing characters in Zsh.
hyperia_setup_prompt() {
  local esc=$'\e'
  local bel=$'\a'
  if [[ "$PROMPT" != *"%{${esc}]133;B${bel}}"* ]]; then
    PROMPT="%{${esc}]133;B${bel}%}$PROMPT"
  fi
}
hyperia_setup_prompt
unfunction hyperia_setup_prompt
