import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type BeaconState =
  | "off"
  | "idle"
  | "working"
  | "reading"
  | "writing"
  | "running"
  | "waiting"
  | "success"
  | "error";
type ToolInfo = { state: BeaconState; order: number };

function generateSourceId(): string {
  const randomPart = Math.random().toString(36).slice(2, 10);
  const timePart = Date.now().toString(36).slice(-6);
  return `pi:${randomPart}${timePart}`;
}

const STATUS_BEACON_ENTRY_ID = "riccardomarotti/status-beacon:status";
const STATUS_BEACON_SOURCE_ID = generateSourceId();
const HEARTBEAT_MS = 5_000;
const ERROR_DURATION_MS = 1_200;
const IPC_TIMEOUT_MS = 400;

const TOOL_STATE_PRIORITY: Record<BeaconState, number> = {
  off: 0,
  idle: 0,
  working: 1,
  reading: 2,
  running: 3,
  writing: 4,
  waiting: 0,
  success: 0,
  error: 0,
};

function semanticState(toolName: string): BeaconState {
  const normalized = toolName.toLowerCase();
  if (
    [
      "read",
      "grep",
      "find",
      "ls",
      "ck_semantic_search",
      "ck_hybrid_search",
      "ck_regex_search",
    ].includes(normalized)
  ) {
    return "reading";
  }
  if (["edit", "write"].includes(normalized)) {
    return "writing";
  }
  if (["bash", "powershell", "shell", "exec", "run"].includes(normalized)) {
    return "running";
  }
  return "working";
}

export default function (pi: ExtensionAPI) {
  let sessionActive = false;
  let agentRunning = false;
  let waitingForInput = false;
  let toolOrder = 0;
  let activeTools = new Map<string, ToolInfo>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  let errorGeneration = 0;
  let temporaryErrorUntil = 0;

  // Keep at most one IPC request in flight and one latest request pending. A
  // missing or slow Noctalia must never build an unbounded queue in Pi.
  let transportPromise: Promise<void> | null = null;
  let pendingState: BeaconState | null = null;
  let pendingForce = false;
  let pendingHeartbeat = false;
  let pendingTouch = false;
  let pendingClear = false;
  let lastSentState: BeaconState | null = null;
  let desiredState: BeaconState | null = null;
  let sourceRegistered = false;

  function computeCurrentState(): BeaconState {
    if (!sessionActive) return "off";
    if (temporaryErrorUntil > Date.now()) return "error";
    if (waitingForInput) return "waiting";

    let selected: ToolInfo | undefined;
    for (const tool of activeTools.values()) {
      if (
        selected === undefined ||
        TOOL_STATE_PRIORITY[tool.state] > TOOL_STATE_PRIORITY[selected.state] ||
        (TOOL_STATE_PRIORITY[tool.state] ===
          TOOL_STATE_PRIORITY[selected.state] &&
          tool.order > selected.order)
      ) {
        selected = tool;
      }
    }
    if (selected !== undefined) return selected.state;
    if (agentRunning) return "working";
    return "idle";
  }

  function ensureTransport(): Promise<void> {
    if (transportPromise === null) {
      const promise = flushTransport();
      transportPromise = promise;
      const finish = () => {
        if (transportPromise !== promise) return;
        transportPromise = null;
        if (
          pendingClear ||
          pendingState !== null ||
          pendingHeartbeat ||
          pendingTouch
        )
          ensureTransport();
      };
      void promise.then(finish, finish);
    }
    return transportPromise;
  }

  function requestState(state: BeaconState, force = false): Promise<void> {
    if (pendingClear) return ensureTransport();
    desiredState = state;
    pendingState = state;
    pendingForce = pendingForce || force;
    return ensureTransport();
  }

  function requestHeartbeat(): Promise<void> {
    if (pendingClear) return ensureTransport();
    pendingHeartbeat = true;
    return ensureTransport();
  }

  function requestTouch(): Promise<void> {
    if (pendingClear) return ensureTransport();
    pendingTouch = true;
    return ensureTransport();
  }

  function requestClear(): Promise<void> {
    pendingState = null;
    pendingForce = false;
    pendingHeartbeat = false;
    pendingTouch = false;
    pendingClear = true;
    return ensureTransport();
  }

  async function flushTransport(): Promise<void> {
    const command = ["msg", "plugin", STATUS_BEACON_ENTRY_ID, "all"];
    while (
      pendingClear ||
      pendingState !== null ||
      pendingHeartbeat ||
      pendingTouch
    ) {
      if (pendingClear) {
        pendingClear = false;
        try {
          const result = await pi.exec(
            "noctalia",
            [...command, "clear", STATUS_BEACON_SOURCE_ID],
            {
              timeout: IPC_TIMEOUT_MS,
            },
          );
          if (result.code === 0) {
            lastSentState = null;
            desiredState = null;
            sourceRegistered = false;
          }
        } catch {
          // Status Beacon is deliberately best-effort; Pi remains fully functional
          // when Noctalia is stopped, unavailable, or still starting.
        }
        continue;
      }

      if (pendingState !== null) {
        const state = pendingState;
        const force = pendingForce;
        pendingState = null;
        pendingForce = false;

        if (!force && state === lastSentState && sourceRegistered) continue;

        try {
          const result = await pi.exec(
            "noctalia",
            [...command, "set", STATUS_BEACON_SOURCE_ID, state],
            {
              timeout: IPC_TIMEOUT_MS,
            },
          );
          if (result.code === 0) {
            lastSentState = state;
            sourceRegistered = true;
          } else {
            sourceRegistered = false;
          }
        } catch {
          sourceRegistered = false;
          // Status Beacon is deliberately best-effort; Pi remains fully functional
          // when Noctalia is stopped, unavailable, or still starting.
        }
        continue;
      }

      if (pendingTouch) {
        pendingTouch = false;
        if (!sourceRegistered && desiredState !== null) {
          pendingState = desiredState;
          pendingForce = true;
          continue;
        }

        try {
          const result = await pi.exec(
            "noctalia",
            [...command, "touch", STATUS_BEACON_SOURCE_ID],
            {
              timeout: IPC_TIMEOUT_MS,
            },
          );
          if (result.code !== 0) sourceRegistered = false;
        } catch {
          sourceRegistered = false;
          // Status Beacon is deliberately best-effort; Pi remains fully functional
          // when Noctalia is stopped, unavailable, or still starting.
        }
        continue;
      }

      pendingHeartbeat = false;
      if (!sourceRegistered && desiredState !== null) {
        pendingState = desiredState;
        pendingForce = true;
        continue;
      }

      try {
        const result = await pi.exec(
          "noctalia",
          [...command, "heartbeat", STATUS_BEACON_SOURCE_ID],
          {
            timeout: IPC_TIMEOUT_MS,
          },
        );
        if (result.code !== 0) sourceRegistered = false;
      } catch {
        sourceRegistered = false;
        // Status Beacon is deliberately best-effort; Pi remains fully functional
        // when Noctalia is stopped, unavailable, or still starting.
      }
    }
  }

  function publishCurrentState(force = false): void {
    requestState(computeCurrentState(), force);
  }

  function clearErrorState(): void {
    errorGeneration += 1;
    temporaryErrorUntil = 0;
    if (errorTimer !== null) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
  }

  function showTemporaryError(): void {
    const generation = ++errorGeneration;
    temporaryErrorUntil = Date.now() + ERROR_DURATION_MS;
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      if (generation !== errorGeneration) return;
      temporaryErrorUntil = 0;
      errorTimer = null;
      publishCurrentState();
    }, ERROR_DURATION_MS);
    publishCurrentState();
  }

  function startHeartbeat(): void {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      void requestHeartbeat();
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  pi.on("session_start", () => {
    sessionActive = true;
    agentRunning = false;
    waitingForInput = false;
    activeTools.clear();
    clearErrorState();
    startHeartbeat();
    publishCurrentState(true);
  });

  pi.on("session_shutdown", async () => {
    sessionActive = false;
    agentRunning = false;
    waitingForInput = false;
    activeTools.clear();
    stopHeartbeat();
    clearErrorState();
    await requestClear();
  });

  pi.on("agent_start", () => {
    waitingForInput = false;
    agentRunning = true;
    activeTools.clear();
    publishCurrentState();
  });

  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc")
      void requestTouch();
  });

  pi.on("agent_settled", () => {
    agentRunning = false;
    publishCurrentState();
  });

  pi.on("ui_prompt_start", () => {
    waitingForInput = true;
    publishCurrentState();
  });

  pi.on("ui_prompt_end", () => {
    waitingForInput = false;
    publishCurrentState();
  });

  pi.on("tool_execution_start", (event) => {
    if (typeof event.toolCallId !== "string") return;
    activeTools.set(event.toolCallId, {
      state: semanticState(event.toolName),
      order: ++toolOrder,
    });
    publishCurrentState();
  });

  pi.on("tool_execution_end", (event) => {
    if (typeof event.toolCallId === "string")
      activeTools.delete(event.toolCallId);
    if (event.isError) showTemporaryError();
    publishCurrentState();
  });
}
