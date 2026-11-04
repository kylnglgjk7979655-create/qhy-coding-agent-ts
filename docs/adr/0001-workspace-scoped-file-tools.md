# Scope Agent file access to the workspace

The Agent's `read_file` and `write_file` tools may access files only within the configured workspace, with relative paths resolved from that workspace and absolute paths accepted when they remain inside it. No per-operation confirmation is required; paths that escape the workspace, including through symlinks, are rejected. This gives the Agent direct file-editing ability while keeping its filesystem access bounded to the project the user selected.
