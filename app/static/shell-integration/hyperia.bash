# Hyperia Bash Integration
#
# Reports, via OSC sequences, what the shell is doing:
#   133;A / 133;B / 133;C / 133;D  prompt start / prompt end / command start / command end
#   697;cmd=…;app=…;argv0=…;pid=…  the command line about to run (base64)
#   7;file://…                     the cwd at every prompt
#
# Two hook strategies, chosen once at source time:
#   - bash-preexec present (rcaloras/bash-preexec, usually loaded from ~/.bashrc):
#     register with ITS preexec/precmd arrays. Setting our own DEBUG trap next
#     to it is not an option: bash-preexec replaces the DEBUG trap at the first
#     prompt and re-invokes the old one as a preexec function, and our old
#     history-number dedupe then swallowed the FIRST command typed in every new
#     pane (the number was recorded while bash-preexec's install commands ran
#     under the prompt). Its `$1` is also the full typed line, where BASH_COMMAND
#     is only the first simple command of a pipeline.
#   - otherwise: our own DEBUG trap, deduped by a prompt marker — only the first
#     simple command after the prompt is the typed line; the rest of a pipeline
#     and PROMPT_COMMAND's own commands are ignored.

hyperia_base64() {
  if command -v base64 >/dev/null 2>&1; then
    printf "%s" "$1" | base64 | tr -d '\n\r'
  elif command -v openssl >/dev/null 2>&1; then
    printf "%s" "$1" | openssl base64 | tr -d '\n\r'
  else
    printf "%s" "$1"
  fi
}

# Emit 133;C + 697 for one command line ($1).
hyperia_report_command() {
  printf "\033]133;C\007"

  local cmd_line="$1"
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
}

# DEBUG-trap path (no bash-preexec).
hyperia_preexec() {
  if [ -n "$COMP_LINE" ]; then
    return
  fi
  if [ "$BASH_SUBSHELL" -gt 0 ]; then
    return
  fi
  if [ "$hyperia_in_preexec" = "1" ]; then
    return
  fi
  # Only the first simple command after a prompt is what the user typed;
  # hyperia_prompt_ready (last in PROMPT_COMMAND) re-arms this.
  if [ -z "$hyperia_at_prompt" ]; then
    return
  fi
  hyperia_at_prompt=""
  hyperia_in_preexec=1
  hyperia_report_command "$BASH_COMMAND"
  hyperia_in_preexec=0
}

# bash-preexec path: $1 is the full command line as typed.
hyperia_bp_preexec() {
  hyperia_report_command "$1"
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

hyperia_prompt_ready() {
  hyperia_at_prompt=1
}

if [ -n "${bash_preexec_imported:-}${__bp_imported:-}" ]; then
  # bash-preexec owns the DEBUG trap and PROMPT_COMMAND; ride its arrays.
  precmd_functions+=(hyperia_precmd)
  preexec_functions+=(hyperia_bp_preexec)
else
  trap 'hyperia_preexec' DEBUG

  # hyperia_precmd FIRST (it needs $? of the user's command), the prompt
  # marker LAST. PROMPT_COMMAND may be an array on bash >= 5.1.
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    if [[ "${PROMPT_COMMAND[*]}" != *"hyperia_precmd"* ]]; then
      PROMPT_COMMAND=("hyperia_precmd" "${PROMPT_COMMAND[@]}" "hyperia_prompt_ready")
    fi
  elif [ -z "$PROMPT_COMMAND" ]; then
    PROMPT_COMMAND="hyperia_precmd; hyperia_prompt_ready"
  elif [[ "$PROMPT_COMMAND" != *"hyperia_precmd"* ]]; then
    PROMPT_COMMAND="hyperia_precmd; $PROMPT_COMMAND; hyperia_prompt_ready"
  fi
fi

# Insert OSC 133 B to PS1 (prompt end)
if [[ "$PS1" != *"\[\033]133;B\007\]"* ]]; then
  PS1="\[\033]133;B\007\]$PS1"
fi
