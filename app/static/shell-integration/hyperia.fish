# Hyperia Fish Integration

function hyperia_base64
  if command -v base64 >/dev/null 2>&1
    printf "%s" "$argv[1]" | base64 | tr -d '\n\r'
  else if command -v openssl >/dev/null 2>&1
    printf "%s" "$argv[1]" | openssl base64 | tr -d '\n\r'
  else
    printf "%s" "$argv[1]"
  end
end

function hyperia_preexec --on-event fish_preexec
  printf "\033]133;C\007"

  set -l cmd_line $argv[1]
  set -l argv0 (string split -m 1 ' ' $cmd_line)[1]
  set -l app_path (type -p "$argv0" 2>/dev/null)
  if test -z "$app_path"
    set app_path (command -v "$argv0" 2>/dev/null)
  end

  set -l b64_cmd (hyperia_base64 "$cmd_line")
  set -l b64_app (hyperia_base64 "$app_path")
  set -l b64_argv0 (hyperia_base64 "$argv0")
  set -l pid $fish_pid

  printf "\033]697;cmd=%s;app=%s;argv0=%s;pid=%s\007" "$b64_cmd" "$b64_app" "$b64_argv0" "$pid"
end

function hyperia_postexec --on-event fish_postexec
  set -l exit_status $status
  printf "\033]133;D;%s\007" "$exit_status"
end

function hyperia_precmd --on-event fish_prompt
  if test -n "$HYPERIA_CTL_DIR"; and test -f "$HYPERIA_CTL_DIR/cd"
    set -l target_dir (cat "$HYPERIA_CTL_DIR/cd")
    rm -f "$HYPERIA_CTL_DIR/cd"
    if test -d "$target_dir"
      cd -- "$target_dir"
    end
  end

  printf "\033]7;file://localhost%s\007" "$PWD"
  printf "\033]133;A\007"
end

# Insert OSC 133 B to the start of the prompt
# We can wrap the existing fish_prompt function
if not functions -q _hyperia_old_fish_prompt
  functions -c fish_prompt _hyperia_old_fish_prompt
  function fish_prompt
    printf "\033]133;B\007"
    _hyperia_old_fish_prompt
  end
end
