from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class InitializeRequest(_message.Message):
    __slots__ = ("session_id", "plan_json")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    PLAN_JSON_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    plan_json: str
    def __init__(self, session_id: _Optional[str] = ..., plan_json: _Optional[str] = ...) -> None: ...

class InitializeResponse(_message.Message):
    __slots__ = ("success", "error", "current_state_id")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    CURRENT_STATE_ID_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    current_state_id: str
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., current_state_id: _Optional[str] = ...) -> None: ...

class CompleteTaskRequest(_message.Message):
    __slots__ = ("session_id", "task_id", "reasoning")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    REASONING_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    task_id: str
    reasoning: str
    def __init__(self, session_id: _Optional[str] = ..., task_id: _Optional[str] = ..., reasoning: _Optional[str] = ...) -> None: ...

class CompleteTaskResponse(_message.Message):
    __slots__ = ("success", "error", "task_completed", "transitioned", "new_state_id", "new_state_title", "progress", "session_completed", "farewell_message", "summary_behavior")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    TASK_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    TRANSITIONED_FIELD_NUMBER: _ClassVar[int]
    NEW_STATE_ID_FIELD_NUMBER: _ClassVar[int]
    NEW_STATE_TITLE_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    SESSION_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    FAREWELL_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_BEHAVIOR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    task_completed: str
    transitioned: bool
    new_state_id: str
    new_state_title: str
    progress: int
    session_completed: bool
    farewell_message: str
    summary_behavior: str
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., task_completed: _Optional[str] = ..., transitioned: _Optional[bool] = ..., new_state_id: _Optional[str] = ..., new_state_title: _Optional[str] = ..., progress: _Optional[int] = ..., session_completed: _Optional[bool] = ..., farewell_message: _Optional[str] = ..., summary_behavior: _Optional[str] = ...) -> None: ...

class SkipTaskRequest(_message.Message):
    __slots__ = ("session_id", "task_id", "reasoning")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    REASONING_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    task_id: str
    reasoning: str
    def __init__(self, session_id: _Optional[str] = ..., task_id: _Optional[str] = ..., reasoning: _Optional[str] = ...) -> None: ...

class SkipTaskResponse(_message.Message):
    __slots__ = ("success", "error", "task_skipped", "transitioned", "new_state_id", "new_state_title", "progress", "session_completed", "farewell_message", "summary_behavior")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    TASK_SKIPPED_FIELD_NUMBER: _ClassVar[int]
    TRANSITIONED_FIELD_NUMBER: _ClassVar[int]
    NEW_STATE_ID_FIELD_NUMBER: _ClassVar[int]
    NEW_STATE_TITLE_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    SESSION_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    FAREWELL_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_BEHAVIOR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    task_skipped: str
    transitioned: bool
    new_state_id: str
    new_state_title: str
    progress: int
    session_completed: bool
    farewell_message: str
    summary_behavior: str
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., task_skipped: _Optional[str] = ..., transitioned: _Optional[bool] = ..., new_state_id: _Optional[str] = ..., new_state_title: _Optional[str] = ..., progress: _Optional[int] = ..., session_completed: _Optional[bool] = ..., farewell_message: _Optional[str] = ..., summary_behavior: _Optional[str] = ...) -> None: ...

class SkipStateRequest(_message.Message):
    __slots__ = ("session_id", "state_id", "reasoning")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_ID_FIELD_NUMBER: _ClassVar[int]
    REASONING_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    state_id: str
    reasoning: str
    def __init__(self, session_id: _Optional[str] = ..., state_id: _Optional[str] = ..., reasoning: _Optional[str] = ...) -> None: ...

class SkipStateResponse(_message.Message):
    __slots__ = ("success", "error", "state_skipped", "tasks_skipped", "transitioned", "new_state_id", "new_state_title", "progress", "session_completed", "farewell_message", "summary_behavior")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    STATE_SKIPPED_FIELD_NUMBER: _ClassVar[int]
    TASKS_SKIPPED_FIELD_NUMBER: _ClassVar[int]
    TRANSITIONED_FIELD_NUMBER: _ClassVar[int]
    NEW_STATE_ID_FIELD_NUMBER: _ClassVar[int]
    NEW_STATE_TITLE_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    SESSION_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    FAREWELL_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_BEHAVIOR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    state_skipped: str
    tasks_skipped: _containers.RepeatedScalarFieldContainer[str]
    transitioned: bool
    new_state_id: str
    new_state_title: str
    progress: int
    session_completed: bool
    farewell_message: str
    summary_behavior: str
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., state_skipped: _Optional[str] = ..., tasks_skipped: _Optional[_Iterable[str]] = ..., transitioned: _Optional[bool] = ..., new_state_id: _Optional[str] = ..., new_state_title: _Optional[str] = ..., progress: _Optional[int] = ..., session_completed: _Optional[bool] = ..., farewell_message: _Optional[str] = ..., summary_behavior: _Optional[str] = ...) -> None: ...

class SetDeliverableRequest(_message.Message):
    __slots__ = ("session_id", "key", "value", "reasoning", "unconfirmed")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    KEY_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    REASONING_FIELD_NUMBER: _ClassVar[int]
    UNCONFIRMED_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    key: str
    value: str
    reasoning: str
    unconfirmed: bool
    def __init__(self, session_id: _Optional[str] = ..., key: _Optional[str] = ..., value: _Optional[str] = ..., reasoning: _Optional[str] = ..., unconfirmed: _Optional[bool] = ...) -> None: ...

class SetDeliverableResponse(_message.Message):
    __slots__ = ("success", "error", "task_completed", "transitioned", "new_state_id", "new_state_title", "progress", "session_completed", "farewell_message", "summary_behavior")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    TASK_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    TRANSITIONED_FIELD_NUMBER: _ClassVar[int]
    NEW_STATE_ID_FIELD_NUMBER: _ClassVar[int]
    NEW_STATE_TITLE_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    SESSION_COMPLETED_FIELD_NUMBER: _ClassVar[int]
    FAREWELL_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    SUMMARY_BEHAVIOR_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    task_completed: str
    transitioned: bool
    new_state_id: str
    new_state_title: str
    progress: int
    session_completed: bool
    farewell_message: str
    summary_behavior: str
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., task_completed: _Optional[str] = ..., transitioned: _Optional[bool] = ..., new_state_id: _Optional[str] = ..., new_state_title: _Optional[str] = ..., progress: _Optional[int] = ..., session_completed: _Optional[bool] = ..., farewell_message: _Optional[str] = ..., summary_behavior: _Optional[str] = ...) -> None: ...

class GetCurrentStateRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class GetCurrentStateResponse(_message.Message):
    __slots__ = ("success", "error", "state_id", "state_title", "state_type", "progress", "turns_without_progress", "total_turns", "goal_objective", "goal_context", "goal_depth_guidance", "goal_boundaries", "goal_success_description")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    STATE_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_TITLE_FIELD_NUMBER: _ClassVar[int]
    STATE_TYPE_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    TURNS_WITHOUT_PROGRESS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TURNS_FIELD_NUMBER: _ClassVar[int]
    GOAL_OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    GOAL_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    GOAL_DEPTH_GUIDANCE_FIELD_NUMBER: _ClassVar[int]
    GOAL_BOUNDARIES_FIELD_NUMBER: _ClassVar[int]
    GOAL_SUCCESS_DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    state_id: str
    state_title: str
    state_type: str
    progress: int
    turns_without_progress: int
    total_turns: int
    goal_objective: str
    goal_context: str
    goal_depth_guidance: str
    goal_boundaries: str
    goal_success_description: str
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., state_id: _Optional[str] = ..., state_title: _Optional[str] = ..., state_type: _Optional[str] = ..., progress: _Optional[int] = ..., turns_without_progress: _Optional[int] = ..., total_turns: _Optional[int] = ..., goal_objective: _Optional[str] = ..., goal_context: _Optional[str] = ..., goal_depth_guidance: _Optional[str] = ..., goal_boundaries: _Optional[str] = ..., goal_success_description: _Optional[str] = ...) -> None: ...

class GetPendingTasksRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class PendingTask(_message.Message):
    __slots__ = ("id", "description", "instruction", "required", "has_deliverables", "deliverable_keys", "is_preview", "is_goal")
    ID_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    HAS_DELIVERABLES_FIELD_NUMBER: _ClassVar[int]
    DELIVERABLE_KEYS_FIELD_NUMBER: _ClassVar[int]
    IS_PREVIEW_FIELD_NUMBER: _ClassVar[int]
    IS_GOAL_FIELD_NUMBER: _ClassVar[int]
    id: str
    description: str
    instruction: str
    required: bool
    has_deliverables: bool
    deliverable_keys: _containers.RepeatedScalarFieldContainer[str]
    is_preview: bool
    is_goal: bool
    def __init__(self, id: _Optional[str] = ..., description: _Optional[str] = ..., instruction: _Optional[str] = ..., required: _Optional[bool] = ..., has_deliverables: _Optional[bool] = ..., deliverable_keys: _Optional[_Iterable[str]] = ..., is_preview: _Optional[bool] = ..., is_goal: _Optional[bool] = ...) -> None: ...

class GetPendingTasksResponse(_message.Message):
    __slots__ = ("success", "error", "tasks")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    TASKS_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    tasks: _containers.RepeatedCompositeFieldContainer[PendingTask]
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., tasks: _Optional[_Iterable[_Union[PendingTask, _Mapping]]] = ...) -> None: ...

class GetPendingDeliverablesRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class PendingDeliverable(_message.Message):
    __slots__ = ("key", "description", "type", "required", "acceptance_criteria", "task_id")
    KEY_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    ACCEPTANCE_CRITERIA_FIELD_NUMBER: _ClassVar[int]
    TASK_ID_FIELD_NUMBER: _ClassVar[int]
    key: str
    description: str
    type: str
    required: bool
    acceptance_criteria: str
    task_id: str
    def __init__(self, key: _Optional[str] = ..., description: _Optional[str] = ..., type: _Optional[str] = ..., required: _Optional[bool] = ..., acceptance_criteria: _Optional[str] = ..., task_id: _Optional[str] = ...) -> None: ...

class GetPendingDeliverablesResponse(_message.Message):
    __slots__ = ("success", "error", "deliverables")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    DELIVERABLES_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    deliverables: _containers.RepeatedCompositeFieldContainer[PendingDeliverable]
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., deliverables: _Optional[_Iterable[_Union[PendingDeliverable, _Mapping]]] = ...) -> None: ...

class IncrementTurnRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class IncrementTurnResponse(_message.Message):
    __slots__ = ("success", "error", "turns_without_progress")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    TURNS_WITHOUT_PROGRESS_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    turns_without_progress: int
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., turns_without_progress: _Optional[int] = ...) -> None: ...

class GetCollectedDeliverablesRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class CollectedDeliverable(_message.Message):
    __slots__ = ("key", "value")
    KEY_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    key: str
    value: str
    def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...

class GetCollectedDeliverablesResponse(_message.Message):
    __slots__ = ("success", "error", "deliverables")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    DELIVERABLES_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    deliverables: _containers.RepeatedCompositeFieldContainer[CollectedDeliverable]
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., deliverables: _Optional[_Iterable[_Union[CollectedDeliverable, _Mapping]]] = ...) -> None: ...

class GetFullStateRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class FullStateDeliverable(_message.Message):
    __slots__ = ("key", "description", "type", "required", "status", "value", "collected_at", "acceptance_criteria", "reasoning", "discovered")
    KEY_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    COLLECTED_AT_FIELD_NUMBER: _ClassVar[int]
    ACCEPTANCE_CRITERIA_FIELD_NUMBER: _ClassVar[int]
    REASONING_FIELD_NUMBER: _ClassVar[int]
    DISCOVERED_FIELD_NUMBER: _ClassVar[int]
    key: str
    description: str
    type: str
    required: bool
    status: str
    value: str
    collected_at: str
    acceptance_criteria: str
    reasoning: str
    discovered: bool
    def __init__(self, key: _Optional[str] = ..., description: _Optional[str] = ..., type: _Optional[str] = ..., required: _Optional[bool] = ..., status: _Optional[str] = ..., value: _Optional[str] = ..., collected_at: _Optional[str] = ..., acceptance_criteria: _Optional[str] = ..., reasoning: _Optional[str] = ..., discovered: _Optional[bool] = ...) -> None: ...

class FullStateTask(_message.Message):
    __slots__ = ("id", "description", "instruction", "required", "status", "deliverables")
    ID_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    INSTRUCTION_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    DELIVERABLES_FIELD_NUMBER: _ClassVar[int]
    id: str
    description: str
    instruction: str
    required: bool
    status: str
    deliverables: _containers.RepeatedCompositeFieldContainer[FullStateDeliverable]
    def __init__(self, id: _Optional[str] = ..., description: _Optional[str] = ..., instruction: _Optional[str] = ..., required: _Optional[bool] = ..., status: _Optional[str] = ..., deliverables: _Optional[_Iterable[_Union[FullStateDeliverable, _Mapping]]] = ...) -> None: ...

class FullStateState(_message.Message):
    __slots__ = ("id", "title", "type", "status", "tasks", "goal_objective", "goal_context", "goal_depth_guidance", "goal_boundaries", "goal_success_description")
    ID_FIELD_NUMBER: _ClassVar[int]
    TITLE_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    TASKS_FIELD_NUMBER: _ClassVar[int]
    GOAL_OBJECTIVE_FIELD_NUMBER: _ClassVar[int]
    GOAL_CONTEXT_FIELD_NUMBER: _ClassVar[int]
    GOAL_DEPTH_GUIDANCE_FIELD_NUMBER: _ClassVar[int]
    GOAL_BOUNDARIES_FIELD_NUMBER: _ClassVar[int]
    GOAL_SUCCESS_DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    id: str
    title: str
    type: str
    status: str
    tasks: _containers.RepeatedCompositeFieldContainer[FullStateTask]
    goal_objective: str
    goal_context: str
    goal_depth_guidance: str
    goal_boundaries: str
    goal_success_description: str
    def __init__(self, id: _Optional[str] = ..., title: _Optional[str] = ..., type: _Optional[str] = ..., status: _Optional[str] = ..., tasks: _Optional[_Iterable[_Union[FullStateTask, _Mapping]]] = ..., goal_objective: _Optional[str] = ..., goal_context: _Optional[str] = ..., goal_depth_guidance: _Optional[str] = ..., goal_boundaries: _Optional[str] = ..., goal_success_description: _Optional[str] = ...) -> None: ...

class GetFullStateResponse(_message.Message):
    __slots__ = ("success", "error", "plan_id", "plan_title", "current_state_id", "progress", "total_turns", "turns_without_progress", "states", "collected_deliverables")
    class CollectedDeliverablesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    PLAN_ID_FIELD_NUMBER: _ClassVar[int]
    PLAN_TITLE_FIELD_NUMBER: _ClassVar[int]
    CURRENT_STATE_ID_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TURNS_FIELD_NUMBER: _ClassVar[int]
    TURNS_WITHOUT_PROGRESS_FIELD_NUMBER: _ClassVar[int]
    STATES_FIELD_NUMBER: _ClassVar[int]
    COLLECTED_DELIVERABLES_FIELD_NUMBER: _ClassVar[int]
    success: bool
    error: str
    plan_id: str
    plan_title: str
    current_state_id: str
    progress: int
    total_turns: int
    turns_without_progress: int
    states: _containers.RepeatedCompositeFieldContainer[FullStateState]
    collected_deliverables: _containers.ScalarMap[str, str]
    def __init__(self, success: _Optional[bool] = ..., error: _Optional[str] = ..., plan_id: _Optional[str] = ..., plan_title: _Optional[str] = ..., current_state_id: _Optional[str] = ..., progress: _Optional[int] = ..., total_turns: _Optional[int] = ..., turns_without_progress: _Optional[int] = ..., states: _Optional[_Iterable[_Union[FullStateState, _Mapping]]] = ..., collected_deliverables: _Optional[_Mapping[str, str]] = ...) -> None: ...
