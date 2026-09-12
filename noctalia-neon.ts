import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type NeonState =
  | "off"
  | "idle"
  | "working"
  | "reading"
  | "writing"
  | "running"
  | "waiting"
  | "success"
  | "error";
type ToolInfo = { state: NeonState; order: number };

const ENTRY_ID = "ric/neon:status";
const HEARTBEAT_MS = 5_000;
const ERROR_DURATION_MS = 1_200;
const IPC_TIMEOUT_MS = 400;

const TOOL_STATE_PRIORITY: Record<NeonState, number> = {
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

function semanticState(toolName: string): NeonState {
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
  let pendingState: NeonState | null = null;
  let pendingForce = false;
  let lastSentState: NeonState | null = null;

  function computeCurrentState(): NeonState {
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

  function requestState(state: NeonState, force = false): Promise<void> {
    pendingState = state;
    pendingForce = pendingForce || force;

    if (transportPromise === null) {
      const promise = flushTransport();
      transportPromise = promise;
      const finish = () => {
        if (transportPromise !== promise) return;
        transportPromise = null;
        if (pendingState !== null) requestState(pendingState, pendingForce);
      };
      void promise.then(finish, finish);
    }

    return transportPromise;
  }

  async function flushTransport(): Promise<void> {
    while (pendingState !== null) {
      const state = pendingState;
      const force = pendingForce;
      pendingState = null;
      pendingForce = false;

      if (!force && state === lastSentState) continue;

      const command = ["msg", "plugin", ENTRY_ID, "all"];
      const args =
        state === "off" ? [...command, "off"] : [...command, "set", state];
      try {
        const result = await pi.exec("noctalia", args, {
          timeout: IPC_TIMEOUT_MS,
        });
        if (result.code === 0) lastSentState = state;
      } catch {
        // Neon is deliberately best-effort; Pi remains fully functional
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
    heartbeatTimer = setInterval(() => publishCurrentState(true), HEARTBEAT_MS);
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
    await requestState("off", true);
  });

  pi.on("agent_start", () => {
    agentRunning = true;
    activeTools.clear();
    publishCurrentState();
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
