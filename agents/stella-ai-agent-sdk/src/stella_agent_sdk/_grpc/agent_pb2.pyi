from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class AgentState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AGENT_STATE_UNKNOWN: _ClassVar[AgentState]
    AGENT_STATE_INITIALIZING: _ClassVar[AgentState]
    AGENT_STATE_READY: _ClassVar[AgentState]
    AGENT_STATE_PROCESSING: _ClassVar[AgentState]
    AGENT_STATE_INTERRUPTED: _ClassVar[AgentState]
    AGENT_STATE_ERROR: _ClassVar[AgentState]
    AGENT_STATE_SHUTTING_DOWN: _ClassVar[AgentState]

class InputType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    INPUT_TYPE_UNSPECIFIED: _ClassVar[InputType]
    INPUT_TYPE_TEXT: _ClassVar[InputType]
    INPUT_TYPE_INTERRUPT: _ClassVar[InputType]
    INPUT_TYPE_SESSION_START: _ClassVar[InputType]
    INPUT_TYPE_SESSION_END: _ClassVar[InputType]
    INPUT_TYPE_CONFIG: _ClassVar[InputType]
    INPUT_TYPE_HEALTH_CHECK: _ClassVar[InputType]

class OutputType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OUTPUT_TYPE_UNSPECIFIED: _ClassVar[OutputType]
    OUTPUT_TYPE_TEXT_CHUNK: _ClassVar[OutputType]
    OUTPUT_TYPE_TEXT_FINAL: _ClassVar[OutputType]
    OUTPUT_TYPE_STATUS: _ClassVar[OutputType]
    OUTPUT_TYPE_METADATA: _ClassVar[OutputType]
    OUTPUT_TYPE_ERROR: _ClassVar[OutputType]
    OUTPUT_TYPE_HEALTH_STATUS: _ClassVar[OutputType]

class StatusSubtype(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    STATUS_SUBTYPE_UNSPECIFIED: _ClassVar[StatusSubtype]
    STATUS_SUBTYPE_PROCESSING: _ClassVar[StatusSubtype]
    STATUS_SUBTYPE_THINKING: _ClassVar[StatusSubtype]
    STATUS_SUBTYPE_EXPERT_START: _ClassVar[StatusSubtype]
    STATUS_SUBTYPE_EXPERT_COMPLETE: _ClassVar[StatusSubtype]
    STATUS_SUBTYPE_AGGREGATING: _ClassVar[StatusSubtype]

class MetadataSubtype(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    METADATA_SUBTYPE_UNSPECIFIED: _ClassVar[MetadataSubtype]
    METADATA_SUBTYPE_PLAN_UPDATE: _ClassVar[MetadataSubtype]
    METADATA_SUBTYPE_TASK_UPDATE: _ClassVar[MetadataSubtype]
    METADATA_SUBTYPE_DELIVERABLE: _ClassVar[MetadataSubtype]
    METADATA_SUBTYPE_PROGRESS: _ClassVar[MetadataSubtype]
    METADATA_SUBTYPE_STATE_TRANSITION: _ClassVar[MetadataSubtype]
AGENT_STATE_UNKNOWN: AgentState
AGENT_STATE_INITIALIZING: AgentState
AGENT_STATE_READY: AgentState
AGENT_STATE_PROCESSING: AgentState
AGENT_STATE_INTERRUPTED: AgentState
AGENT_STATE_ERROR: AgentState
AGENT_STATE_SHUTTING_DOWN: AgentState
INPUT_TYPE_UNSPECIFIED: InputType
INPUT_TYPE_TEXT: InputType
INPUT_TYPE_INTERRUPT: InputType
INPUT_TYPE_SESSION_START: InputType
INPUT_TYPE_SESSION_END: InputType
INPUT_TYPE_CONFIG: InputType
INPUT_TYPE_HEALTH_CHECK: InputType
OUTPUT_TYPE_UNSPECIFIED: OutputType
OUTPUT_TYPE_TEXT_CHUNK: OutputType
OUTPUT_TYPE_TEXT_FINAL: OutputType
OUTPUT_TYPE_STATUS: OutputType
OUTPUT_TYPE_METADATA: OutputType
OUTPUT_TYPE_ERROR: OutputType
OUTPUT_TYPE_HEALTH_STATUS: OutputType
STATUS_SUBTYPE_UNSPECIFIED: StatusSubtype
STATUS_SUBTYPE_PROCESSING: StatusSubtype
STATUS_SUBTYPE_THINKING: StatusSubtype
STATUS_SUBTYPE_EXPERT_START: StatusSubtype
STATUS_SUBTYPE_EXPERT_COMPLETE: StatusSubtype
STATUS_SUBTYPE_AGGREGATING: StatusSubtype
METADATA_SUBTYPE_UNSPECIFIED: MetadataSubtype
METADATA_SUBTYPE_PLAN_UPDATE: MetadataSubtype
METADATA_SUBTYPE_TASK_UPDATE: MetadataSubtype
METADATA_SUBTYPE_DELIVERABLE: MetadataSubtype
METADATA_SUBTYPE_PROGRESS: MetadataSubtype
METADATA_SUBTYPE_STATE_TRANSITION: MetadataSubtype

class AgentInputProto(_message.Message):
    __slots__ = ("session_id", "type", "text", "history", "metadata", "timestamp_ms", "health_check")
    class MetadataEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    HISTORY_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_MS_FIELD_NUMBER: _ClassVar[int]
    HEALTH_CHECK_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    type: InputType
    text: str
    history: _containers.RepeatedCompositeFieldContainer[ConversationTurn]
    metadata: _containers.ScalarMap[str, str]
    timestamp_ms: int
    health_check: StreamHealthCheckRequest
    def __init__(self, session_id: _Optional[str] = ..., type: _Optional[_Union[InputType, str]] = ..., text: _Optional[str] = ..., history: _Optional[_Iterable[_Union[ConversationTurn, _Mapping]]] = ..., metadata: _Optional[_Mapping[str, str]] = ..., timestamp_ms: _Optional[int] = ..., health_check: _Optional[_Union[StreamHealthCheckRequest, _Mapping]] = ...) -> None: ...

class StreamHealthCheckRequest(_message.Message):
    __slots__ = ("request_id",)
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    def __init__(self, request_id: _Optional[str] = ...) -> None: ...

class ConversationTurn(_message.Message):
    __slots__ = ("role", "content")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    role: str
    content: str
    def __init__(self, role: _Optional[str] = ..., content: _Optional[str] = ...) -> None: ...

class AgentOutputProto(_message.Message):
    __slots__ = ("session_id", "type", "content", "is_final", "transcript_id", "status_subtype", "metadata_subtype", "metadata", "timestamp_ms", "health_status")
    class MetadataEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    IS_FINAL_FIELD_NUMBER: _ClassVar[int]
    TRANSCRIPT_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_SUBTYPE_FIELD_NUMBER: _ClassVar[int]
    METADATA_SUBTYPE_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    TIMESTAMP_MS_FIELD_NUMBER: _ClassVar[int]
    HEALTH_STATUS_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    type: OutputType
    content: str
    is_final: bool
    transcript_id: str
    status_subtype: StatusSubtype
    metadata_subtype: MetadataSubtype
    metadata: _containers.ScalarMap[str, str]
    timestamp_ms: int
    health_status: StreamHealthStatusResponse
    def __init__(self, session_id: _Optional[str] = ..., type: _Optional[_Union[OutputType, str]] = ..., content: _Optional[str] = ..., is_final: bool = ..., transcript_id: _Optional[str] = ..., status_subtype: _Optional[_Union[StatusSubtype, str]] = ..., metadata_subtype: _Optional[_Union[MetadataSubtype, str]] = ..., metadata: _Optional[_Mapping[str, str]] = ..., timestamp_ms: _Optional[int] = ..., health_status: _Optional[_Union[StreamHealthStatusResponse, _Mapping]] = ...) -> None: ...

class StreamHealthStatusResponse(_message.Message):
    __slots__ = ("request_id", "state", "session_id", "agent_type", "agent_version", "uptime_seconds", "messages_processed", "last_error", "metadata")
    class MetadataEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    AGENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    AGENT_VERSION_FIELD_NUMBER: _ClassVar[int]
    UPTIME_SECONDS_FIELD_NUMBER: _ClassVar[int]
    MESSAGES_PROCESSED_FIELD_NUMBER: _ClassVar[int]
    LAST_ERROR_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    request_id: str
    state: AgentState
    session_id: str
    agent_type: str
    agent_version: str
    uptime_seconds: int
    messages_processed: int
    last_error: str
    metadata: _containers.ScalarMap[str, str]
    def __init__(self, request_id: _Optional[str] = ..., state: _Optional[_Union[AgentState, str]] = ..., session_id: _Optional[str] = ..., agent_type: _Optional[str] = ..., agent_version: _Optional[str] = ..., uptime_seconds: _Optional[int] = ..., messages_processed: _Optional[int] = ..., last_error: _Optional[str] = ..., metadata: _Optional[_Mapping[str, str]] = ...) -> None: ...

class RegisterAgentRequest(_message.Message):
    __slots__ = ("agent_type", "agent_version", "capabilities", "sdk_version")
    class CapabilitiesEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    AGENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    AGENT_VERSION_FIELD_NUMBER: _ClassVar[int]
    CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    SDK_VERSION_FIELD_NUMBER: _ClassVar[int]
    agent_type: str
    agent_version: str
    capabilities: _containers.ScalarMap[str, str]
    sdk_version: str
    def __init__(self, agent_type: _Optional[str] = ..., agent_version: _Optional[str] = ..., capabilities: _Optional[_Mapping[str, str]] = ..., sdk_version: _Optional[str] = ...) -> None: ...

class RegisterAgentResponse(_message.Message):
    __slots__ = ("success", "session_id", "message", "config")
    class ConfigEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    CONFIG_FIELD_NUMBER: _ClassVar[int]
    success: bool
    session_id: str
    message: str
    config: _containers.ScalarMap[str, str]
    def __init__(self, success: bool = ..., session_id: _Optional[str] = ..., message: _Optional[str] = ..., config: _Optional[_Mapping[str, str]] = ...) -> None: ...

class InterruptRequest(_message.Message):
    __slots__ = ("session_id", "reason")
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    reason: str
    def __init__(self, session_id: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class InterruptResponse(_message.Message):
    __slots__ = ("success", "was_processing")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    WAS_PROCESSING_FIELD_NUMBER: _ClassVar[int]
    success: bool
    was_processing: bool
    def __init__(self, success: bool = ..., was_processing: bool = ...) -> None: ...

class EndSessionRequest(_message.Message):
    __slots__ = ("session_id",)
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    session_id: str
    def __init__(self, session_id: _Optional[str] = ...) -> None: ...

class EndSessionResponse(_message.Message):
    __slots__ = ("success", "final_data")
    class FinalDataEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    FINAL_DATA_FIELD_NUMBER: _ClassVar[int]
    success: bool
    final_data: _containers.ScalarMap[str, str]
    def __init__(self, success: bool = ..., final_data: _Optional[_Mapping[str, str]] = ...) -> None: ...

class HealthCheckRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class HealthCheckResponse(_message.Message):
    __slots__ = ("healthy", "agent_type", "agent_version", "session_id")
    HEALTHY_FIELD_NUMBER: _ClassVar[int]
    AGENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    AGENT_VERSION_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    healthy: bool
    agent_type: str
    agent_version: str
    session_id: str
    def __init__(self, healthy: bool = ..., agent_type: _Optional[str] = ..., agent_version: _Optional[str] = ..., session_id: _Optional[str] = ...) -> None: ...
