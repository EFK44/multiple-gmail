## Before you update

- Close the old multiple-gmail window and fully quit Claude Desktop (not just its window) before you replace the file. On Windows a running copy locks the exe.
- Keep the same file path and file name when you replace it. Claude Desktop, Claude Code, Gemini CLI and Start at login store that exact path; a new path makes them start nothing (the wizard then offers Update).
- macOS: drag `multiple-gmail.app` into Applications before the first start; on update choose Replace.
- The macOS builds are tested in CI (unit tests and a smoke test of the built binary) but have not been tested by hand yet. Please report problems.

Check the download against `SHA256SUMS.txt`.
