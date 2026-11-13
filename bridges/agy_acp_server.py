from __future__ import annotations

import asyncio
import os
import sys
import uuid
from dataclasses import dataclass, field
from typing import Any

# Force UTF-8 stdio so Windows GBK/CRLF never corrupts JSON-RPC frames.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")

import acp
from acp import schema
import google.antigravity as agy


def log_err(msg: str) -> None:
    print(f"[agy-acp] {msg}", file=sys.stderr, flush=True)


@dataclass
class SessionState:
    session_id: str
    cwd: str
    agent: agy.Agent
    active_task: asyncio.Task[Any] | None = None
    cancelled: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _extract_prompt_text(prompt_blocks: list[Any]) -> str:
    parts: list[str] = []
    for block in prompt_blocks:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text:
            parts.append(text)
        elif isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts).strip()


def _convert_mcp_servers(mcp_servers: list[Any] | None) -> list[Any]:
    if not mcp_servers:
        return []
    result: list[Any] = []
    for srv in mcp_servers:
        command = getattr(srv, "command", None)
        if not command:
            continue
        name = getattr(srv, "name", "mcp")
        args = list(getattr(srv, "args", []) or [])
        raw_env = getattr(srv, "env", None) or []
        env_dict: dict[str, str] = {}
        if isinstance(raw_env, dict):
            env_dict = {str(k): str(v) for k, v in raw_env.items()}
        elif isinstance(raw_env, list):
            for item in raw_env:
                k = getattr(item, "name", None) or (item.get("name") if isinstance(item, dict) else None)
                v = getattr(item, "value", None) or (item.get("value") if isinstance(item, dict) else None)
                if k is not None and v is not None:
                    env_dict[str(k)] = str(v)
        safe_name = "".join(c if (c.isalnum() or c in "_-") else "_" for c in str(name)) or "mcp"
        result.append(
            agy.types.McpStdioServer(
                name=safe_name,
                command=str(command),
                args=[str(a) for a in args],
                env=env_dict or None,
            )
        )
    return result


class AntigravityAcpAgent:
    """ACP server wrapping the official google-antigravity Python SDK."""

    def __init__(self) -> None:
        self._conn: acp.Client | None = None
        self._sessions: dict[str, SessionState] = {}

    def on_connect(self, conn: acp.Client) -> None:
        self._conn = conn

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: schema.ClientCapabilities | None = None,
        client_info: schema.Implementation | None = None,
        **kwargs: Any,
    ) -> schema.InitializeResponse:
        del client_capabilities, client_info, kwargs
        return schema.InitializeResponse(
            protocol_version=protocol_version,
            agent_capabilities=schema.AgentCapabilities(
                mcp_capabilities=schema.McpCapabilities(http=False, sse=False),
            ),
            agent_info=schema.Implementation(
                name="agy-acp-bridge",
                title="Google Antigravity (Python SDK Bridge)",
                version="0.1.0",
            ),
        )

    async def new_session(
        self,
        cwd: str,
        additional_directories: list[str] | None = None,
        mcp_servers: list[Any] | None = None,
        **kwargs: Any,
    ) -> schema.NewSessionResponse:
        del kwargs
        workspaces = [cwd] + list(additional_directories or [])
        agy_mcp = _convert_mcp_servers(mcp_servers)
        config = agy.LocalAgentConfig(
            workspaces=workspaces,
            capabilities=agy.CapabilitiesConfig(
                agent_behavior=agy.AgentBehavior.AUTONOMOUS,
            ),
            mcp_servers=agy_mcp or None,
            api_key=os.environ.get("GEMINI_API_KEY") or None,
        )
        agent = agy.Agent(config)
        await agent.__aenter__()
        session_id = str(uuid.uuid4())
        self._sessions[session_id] = SessionState(
            session_id=session_id,
            cwd=cwd,
            agent=agent,
        )
        return schema.NewSessionResponse(session_id=session_id)

    async def prompt(
        self,
        session_id: str,
        prompt: list[Any],
        **kwargs: Any,
    ) -> schema.PromptResponse:
        del kwargs
        state = self._sessions.get(session_id)
        if not state:
            raise acp.RequestError.invalid_params({"message": f"Unknown session: {session_id}"})

        text = _extract_prompt_text(prompt)
        if not text:
            return schema.PromptResponse(stop_reason="end_turn")

        async with state.lock:
            state.cancelled = False
            task = asyncio.create_task(self._run_prompt(state, text))
            state.active_task = task
            try:
                stop_reason = await task
                return schema.PromptResponse(stop_reason=stop_reason)
            except asyncio.CancelledError:
                return schema.PromptResponse(stop_reason="cancelled")
            finally:
                state.active_task = None

    async def _run_prompt(self, state: SessionState, prompt_text: str) -> str:
        conn = self._conn
        response = await state.agent.chat(prompt_text)

        async def pump_thoughts() -> None:
            if not conn:
                return
            async for thought in response.thoughts:
                if state.cancelled:
                    break
                chunk_text = thought if isinstance(thought, str) else str(thought)
                if chunk_text:
                    await conn.session_update(
                        session_id=state.session_id,
                        update=schema.AgentThoughtChunk(
                            session_update="agent_thought_chunk",
                            content=schema.TextContentBlock(type="text", text=chunk_text),
                        ),
                    )

        async def pump_tools() -> None:
            if not conn:
                return
            async for call in response.tool_calls:
                if state.cancelled:
                    break
                call_id = str(getattr(call, "id", None) or uuid.uuid4())
                name = str(getattr(call, "name", "tool"))
                args = getattr(call, "args", None)
                await conn.session_update(
                    session_id=state.session_id,
                    update=schema.ToolCallStart(
                        session_update="tool_call",
                        tool_call_id=call_id,
                        title=name,
                        raw_input=args if isinstance(args, dict) else {"args": str(args)},
                    ),
                )

        async def pump_text() -> None:
            if not conn:
                return
            async for delta in response:
                if state.cancelled:
                    break
                chunk_text = delta if isinstance(delta, str) else str(delta)
                if chunk_text:
                    await conn.session_update(
                        session_id=state.session_id,
                        update=schema.AgentMessageChunk(
                            session_update="agent_message_chunk",
                            content=schema.TextContentBlock(type="text", text=chunk_text),
                        ),
                    )

        await asyncio.gather(pump_thoughts(), pump_tools(), pump_text())
        return "cancelled" if state.cancelled else "end_turn"

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        del kwargs
        state = self._sessions.get(session_id)
        if state:
            state.cancelled = True
            if state.active_task and not state.active_task.done():
                state.active_task.cancel()

    async def close_session(self, session_id: str, **kwargs: Any) -> schema.CloseSessionResponse:
        del kwargs
        state = self._sessions.pop(session_id, None)
        if state:
            await state.agent.__aexit__(None, None, None)
        return schema.CloseSessionResponse()


async def main() -> None:
    agent = AntigravityAcpAgent()
    await acp.run_agent(agent)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        log_err(f"Fatal error: {exc}")
        raise
