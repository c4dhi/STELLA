"""Client for communicating with the state machine gRPC service."""

import json
import logging
from typing import Any, Dict, List, Optional

import grpc

from stella_agent_sdk._grpc import state_machine_pb2, state_machine_pb2_grpc

logger = logging.getLogger(__name__)


class StateMachineClient:
    """
    gRPC client for the state machine service.

    This client allows agents to manage conversation state through
    the external state machine service with database persistence.
    """

    def __init__(self, session_id: str, address: str):
        """
        Initialize the client.

        Args:
            session_id: The session ID to manage state for
            address: gRPC server address (e.g., "session-management-server:50052")
        """
        self._session_id = session_id
        self._address = address
        self._channel: Optional[grpc.aio.Channel] = None
        self._stub: Optional[state_machine_pb2_grpc.StateMachineServiceStub] = None

    @property
    def session_id(self) -> str:
        """Get the session ID."""
        return self._session_id

    async def connect(self) -> None:
        """Connect to the gRPC server."""
        logger.info(f"Connecting to state machine server at {self._address}")
        self._channel = grpc.aio.insecure_channel(self._address)
        self._stub = state_machine_pb2_grpc.StateMachineServiceStub(self._channel)
        logger.info("State machine client connected")

    async def disconnect(self) -> None:
        """Disconnect from the gRPC server."""
        if self._channel:
            await self._channel.close()
            self._channel = None
            self._stub = None
            logger.info("State machine client disconnected")

    def _ensure_connected(self) -> None:
        """Ensure client is connected."""
        if not self._stub:
            raise RuntimeError("Client not connected. Call connect() first.")

    async def initialize(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """
        Initialize the state machine with a plan.

        Args:
            plan: The plan configuration

        Returns:
            Dict with success, error, current_state_id
        """
        self._ensure_connected()
        logger.info(f"Initializing state machine for session {self._session_id}")

        try:
            request = state_machine_pb2.InitializeRequest(
                session_id=self._session_id,
                plan_json=json.dumps(plan),
            )
            response = await self._stub.Initialize(request)

            return {
                "success": response.success,
                "error": response.error or None,
                "current_state_id": response.current_state_id or None,
            }
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during initialize: {e.code()} - {e.details()}")
            return {
                "success": False,
                "error": f"gRPC error: {e.details()}",
                "current_state_id": None,
            }

    async def complete_task(
        self,
        task_id: str,
        reasoning: str = "",
    ) -> Dict[str, Any]:
        """
        Mark a task as completed.

        Args:
            task_id: The task ID to complete
            reasoning: Explanation for why task is complete

        Returns:
            Dict with success, error, task_completed, transitioned, new_state_id, progress
        """
        self._ensure_connected()
        logger.info(f"Completing task {task_id} for session {self._session_id}")

        try:
            request = state_machine_pb2.CompleteTaskRequest(
                session_id=self._session_id,
                task_id=task_id,
                reasoning=reasoning,
            )
            response = await self._stub.CompleteTask(request)

            return {
                "success": response.success,
                "error": response.error or None,
                "task_completed": response.task_completed or None,
                "transitioned": response.transitioned,
                "new_state_id": response.new_state_id or None,
                "new_state_title": response.new_state_title or None,
                "progress": response.progress,
                # Set by the backend when the plan reached the __end__ sentinel state.
                # The agent should send farewell_message then stop accepting new turns.
                "session_completed": response.session_completed,
                "farewell_message": response.farewell_message or None,
                "summary_behavior": response.summary_behavior or None,
            }
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during complete_task: {e.code()} - {e.details()}")
            return {
                "success": False,
                "error": f"gRPC error: {e.details()}",
            }

    async def skip_task(
        self,
        task_id: str,
        reasoning: str = "",
    ) -> Dict[str, Any]:
        """
        Skip a single task the agent judges unnecessary.

        Skipping counts toward state completion exactly like completing — it is
        one of the explicit ways the agent addresses a task. ``required`` is
        advisory only; any task may be skipped.

        Args:
            task_id: The task ID to skip
            reasoning: Explanation for why the task is being skipped

        Returns:
            Dict with success, error, task_skipped, transitioned, new_state_id, progress
        """
        self._ensure_connected()
        logger.info(f"Skipping task {task_id} for session {self._session_id}")

        try:
            request = state_machine_pb2.SkipTaskRequest(
                session_id=self._session_id,
                task_id=task_id,
                reasoning=reasoning,
            )
            response = await self._stub.SkipTask(request)

            return {
                "success": response.success,
                "error": response.error or None,
                "task_skipped": response.task_skipped or None,
                "transitioned": response.transitioned,
                "new_state_id": response.new_state_id or None,
                "new_state_title": response.new_state_title or None,
                "progress": response.progress,
                "session_completed": response.session_completed,
                "farewell_message": response.farewell_message or None,
                "summary_behavior": response.summary_behavior or None,
            }
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during skip_task: {e.code()} - {e.details()}")
            return {
                "success": False,
                "error": f"gRPC error: {e.details()}",
            }

    async def skip_state(
        self,
        state_id: str = "",
        reasoning: str = "",
    ) -> Dict[str, Any]:
        """
        Skip the remainder of a state: mark every not-yet-addressed task skipped
        and advance to the next state.

        Args:
            state_id: Optional state to skip; empty means the current state.
            reasoning: Explanation for skipping the state.

        Returns:
            Dict with success, error, state_skipped, tasks_skipped, transitioned,
            new_state_id, progress
        """
        self._ensure_connected()
        logger.info(f"Skipping state {state_id or '(current)'} for session {self._session_id}")

        try:
            request = state_machine_pb2.SkipStateRequest(
                session_id=self._session_id,
                state_id=state_id,
                reasoning=reasoning,
            )
            response = await self._stub.SkipState(request)

            return {
                "success": response.success,
                "error": response.error or None,
                "state_skipped": response.state_skipped or None,
                "tasks_skipped": list(response.tasks_skipped),
                "transitioned": response.transitioned,
                "new_state_id": response.new_state_id or None,
                "new_state_title": response.new_state_title or None,
                "progress": response.progress,
                "session_completed": response.session_completed,
                "farewell_message": response.farewell_message or None,
                "summary_behavior": response.summary_behavior or None,
            }
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during skip_state: {e.code()} - {e.details()}")
            return {
                "success": False,
                "error": f"gRPC error: {e.details()}",
            }

    async def set_deliverable(
        self,
        key: str,
        value: Any,
        reasoning: str = "",
        unconfirmed: bool = False,
    ) -> Dict[str, Any]:
        """
        Set a deliverable value.

        Args:
            key: The deliverable key
            value: The value to set
            reasoning: Explanation for the value
            unconfirmed: The user mentioned this in passing rather than
                answering a question about it. Recorded, but surfaced to the
                agent as 'partial' so it gets confirmed in conversation instead
                of re-asked. Setting the same key again without this confirms it.

        Returns:
            Dict with success, error, task_completed, transitioned, new_state_id, progress
        """
        self._ensure_connected()
        logger.info(f"Setting deliverable {key} for session {self._session_id}")

        try:
            request = state_machine_pb2.SetDeliverableRequest(
                session_id=self._session_id,
                key=key,
                value=json.dumps(value) if not isinstance(value, str) else value,
                reasoning=reasoning,
                unconfirmed=unconfirmed,
            )
            response = await self._stub.SetDeliverable(request)

            return {
                "success": response.success,
                "error": response.error or None,
                "task_completed": response.task_completed or None,
                "transitioned": response.transitioned,
                "new_state_id": response.new_state_id or None,
                "new_state_title": response.new_state_title or None,
                "progress": response.progress,
                # Set by the backend when the plan reached the __end__ sentinel state.
                # The agent should send farewell_message then stop accepting new turns.
                "session_completed": response.session_completed,
                "farewell_message": response.farewell_message or None,
                "summary_behavior": response.summary_behavior or None,
            }
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during set_deliverable: {e.code()} - {e.details()}")
            return {
                "success": False,
                "error": f"gRPC error: {e.details()}",
            }

    async def get_current_state(self) -> Optional[Dict[str, Any]]:
        """
        Get current state info.

        Returns:
            Dict with state_id, state_title, state_type, progress, etc. or None if not initialized
        """
        self._ensure_connected()

        try:
            request = state_machine_pb2.GetCurrentStateRequest(
                session_id=self._session_id,
            )
            response = await self._stub.GetCurrentState(request)

            if not response.success:
                return None

            return {
                "state_id": response.state_id,
                "state_title": response.state_title,
                "state_type": response.state_type,
                "progress": response.progress,
                "turns_without_progress": response.turns_without_progress,
                "total_turns": response.total_turns,
                "goal_objective": response.goal_objective or None,
                "goal_context": response.goal_context or None,
                "goal_depth_guidance": response.goal_depth_guidance or None,
                "goal_boundaries": response.goal_boundaries or None,
                "goal_success_description": response.goal_success_description or None,
            }
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during get_current_state: {e.code()} - {e.details()}")
            return None

    async def get_pending_tasks(self) -> List[Dict[str, Any]]:
        """
        Get pending tasks in current state.

        Returns filtered by state mode:
        - LOOSE: All pending tasks
        - STRICT: Current task + next task as preview (is_preview=True)

        Returns:
            List of pending task dicts
        """
        self._ensure_connected()

        try:
            request = state_machine_pb2.GetPendingTasksRequest(
                session_id=self._session_id,
            )
            response = await self._stub.GetPendingTasks(request)

            if not response.success:
                return []

            return [
                {
                    "id": task.id,
                    "description": task.description,
                    "instruction": task.instruction or None,
                    "required": task.required,
                    "has_deliverables": task.has_deliverables,
                    "deliverable_keys": list(task.deliverable_keys),
                    "is_preview": task.is_preview,  # True for "next task" preview in strict mode
                }
                for task in response.tasks
            ]
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during get_pending_tasks: {e.code()} - {e.details()}")
            return []

    async def get_pending_deliverables(self) -> List[Dict[str, Any]]:
        """
        Get pending deliverables in current state.

        Returns:
            List of pending deliverable dicts
        """
        self._ensure_connected()

        try:
            request = state_machine_pb2.GetPendingDeliverablesRequest(
                session_id=self._session_id,
            )
            response = await self._stub.GetPendingDeliverables(request)

            if not response.success:
                return []

            return [
                {
                    "key": d.key,
                    "description": d.description,
                    "type": d.type,
                    "required": d.required,
                    "acceptance_criteria": d.acceptance_criteria or None,
                    "examples": list(getattr(d, 'examples', [])),
                    "task_id": d.task_id,
                }
                for d in response.deliverables
            ]
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during get_pending_deliverables: {e.code()} - {e.details()}")
            return []

    async def increment_turn(self) -> int:
        """
        Increment turn counter (when no progress is made).

        Returns:
            Current turns without progress count
        """
        self._ensure_connected()

        try:
            request = state_machine_pb2.IncrementTurnRequest(
                session_id=self._session_id,
            )
            response = await self._stub.IncrementTurn(request)

            return response.turns_without_progress
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during increment_turn: {e.code()} - {e.details()}")
            return 0

    async def get_collected_deliverables(self) -> Dict[str, Any]:
        """
        Get all collected deliverables.

        Returns:
            Dict of key -> value for collected deliverables
        """
        self._ensure_connected()

        try:
            request = state_machine_pb2.GetCollectedDeliverablesRequest(
                session_id=self._session_id,
            )
            response = await self._stub.GetCollectedDeliverables(request)

            if not response.success:
                return {}

            result = {}
            for d in response.deliverables:
                try:
                    result[d.key] = json.loads(d.value)
                except json.JSONDecodeError:
                    result[d.key] = d.value

            return result
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during get_collected_deliverables: {e.code()} - {e.details()}")
            return {}

    async def get_full_state(self) -> Optional[Dict[str, Any]]:
        """
        Get full state machine state (for frontend updates).

        Returns:
            Dict with full state including all states, tasks, deliverables
            or None if not initialized
        """
        self._ensure_connected()

        try:
            request = state_machine_pb2.GetFullStateRequest(
                session_id=self._session_id,
            )
            response = await self._stub.GetFullState(request)

            if not response.success:
                return None

            # Build full state dict
            states = []
            for s in response.states:
                tasks = []
                for t in s.tasks:
                    deliverables = []
                    for d in t.deliverables:
                        deliverable = {
                            "key": d.key,
                            "description": d.description,
                            "type": d.type,
                            "required": d.required,
                            "status": d.status,
                        }
                        if d.value:
                            try:
                                deliverable["value"] = json.loads(d.value)
                            except json.JSONDecodeError:
                                deliverable["value"] = d.value
                        if d.collected_at:
                            deliverable["collected_at"] = d.collected_at
                        if d.acceptance_criteria:
                            deliverable["acceptance_criteria"] = d.acceptance_criteria
                        if d.reasoning:
                            deliverable["reasoning"] = d.reasoning
                        if getattr(d, 'discovered', False):
                            deliverable["discovered"] = True
                        deliverables.append(deliverable)

                    task = {
                        "id": t.id,
                        "description": t.description,
                        "required": t.required,
                        "status": t.status,
                        "deliverables": deliverables,
                    }
                    if t.instruction:
                        task["instruction"] = t.instruction
                    tasks.append(task)

                state = {
                    "id": s.id,
                    "title": s.title,
                    "type": s.type,
                    "status": s.status,
                    "tasks": tasks,
                }
                states.append(state)

            # Parse collected deliverables
            collected = {}
            for key, value in response.collected_deliverables.items():
                try:
                    collected[key] = json.loads(value)
                except json.JSONDecodeError:
                    collected[key] = value

            return {
                "plan_id": response.plan_id,
                "plan_title": response.plan_title,
                "current_state_id": response.current_state_id,
                "progress": response.progress,
                "total_turns": response.total_turns,
                "turns_without_progress": response.turns_without_progress,
                "states": states,
                "collected_deliverables": collected,
            }
        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during get_full_state: {e.code()} - {e.details()}")
            return None
