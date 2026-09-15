# Pi Status Beacon Adapter

This Pi extension publishes Pi session and tool activity to the generic [Status Beacon](https://github.com/riccardomarotti/status-beacon) Noctalia widget.

The adapter is optional. Status Beacon itself does not depend on Pi.

## Installation

Install the Noctalia widget first, then copy the extension into Pi's global extensions directory:

```bash
cp status-beacon.ts ~/.pi/agent/extensions/status-beacon.ts
```

Start or reload Pi with `/reload` after installing or updating the extension.

The GitLab mirror is available at https://gitlab.com/rutilante/pi-status-beacon.

## Behavior

- Each Pi process gets an independent source ID.
- Tool names are mapped to semantic states such as `reading`, `writing`, and `running`.
- Heartbeats keep the source alive while Noctalia is available.
- Interactive and RPC input acknowledges pending Status Beacon idle alerts.
- IPC failures are best-effort and do not interrupt Pi.

## Requirements

- Pi with extension support.
- Noctalia with the `riccardomarotti/status-beacon` plugin installed.

## License

MIT
