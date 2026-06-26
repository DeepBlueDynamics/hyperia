# Hyperia Agent Rules

## Terminal Input Submission
When simulating Enter / Return in terminal tools (like `terminal_keys` or `terminal_run`), agents must use double-escaped `\\n` (or `\\r` for Carriage Return) in their JSON payloads. 

A single `\n` in a JSON string is parsed into a literal newline character by the JSON engine, whereas the underlying terminal integration tools expect the literal two-character string `\\n` to successfully unescape it into a simulated Enter keypress. Failure to double-escape will result in the Enter key being dropped or not registering as a command submission.
