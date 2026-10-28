import React, { useState } from 'react';

interface ComponentInfo {
  id: string;
  label: string;
  sublabel?: string;
  description: string;
  color: string;
}

const componentDetails: Record<string, ComponentInfo> = {
  user: {
    id: 'user',
    label: 'User',
    sublabel: 'Browser',
    description: 'End user interacting via voice (microphone) or text input through the web interface. Audio is captured and streamed via WebRTC.',
    color: '#22c55e',
  },
  livekit: {
    id: 'livekit',
    label: 'LiveKit',
    sublabel: 'WebRTC SFU',
    description: 'External WebRTC SFU server (LiveKit Cloud or self-hosted). Handles real-time audio streaming between users and agents. Manages rooms, participant tokens, and media routing.',
    color: '#f59e0b',
  },
  llm: {
    id: 'llm',
    label: 'LLM API',
    sublabel: 'OpenAI / Ollama',
    description: 'External Large Language Model API. Agents send conversation context and receive streaming text responses for natural dialogue generation.',
    color: '#8b5cf6',
  },
  frontend: {
    id: 'frontend',
    label: 'Frontend',
    sublabel: 'React :5173',
    description: 'React/Vite application with LiveKit SDK. Handles session management UI, audio visualization, chat interface, and agent status display.',
    color: '#3b82f6',
  },
  backend: {
    id: 'backend',
    label: 'Backend',
    sublabel: 'NestJS :3000',
    description: 'NestJS control plane. Manages projects, sessions, agent lifecycle. Generates LiveKit tokens, orchestrates K8s pods, handles WebSocket events.',
    color: '#a855f7',
  },
  postgres: {
    id: 'postgres',
    label: 'PostgreSQL',
    sublabel: ':5432',
    description: 'Database via Prisma ORM. Stores projects, sessions, participants, messages with speaker attribution, and agent configurations.',
    color: '#06b6d4',
  },
  agent: {
    id: 'agent',
    label: 'Agent Pod',
    sublabel: 'Python',
    description: 'Ephemeral K8s pod running stella-v2 or your own agent. Created per session. Receives audio from LiveKit, processes via STT→LLM→TTS pipeline, streams responses back.',
    color: '#ec4899',
  },
  stt: {
    id: 'stt',
    label: 'STT',
    sublabel: 'Sherpa / Whisper',
    description: 'Speech-to-Text gRPC service. Supports Sherpa-ONNX for low-latency streaming recognition or OpenAI Whisper for higher accuracy transcription.',
    color: '#14b8a6',
  },
  tts: {
    id: 'tts',
    label: 'TTS',
    sublabel: 'Piper / Kokoro',
    description: 'Text-to-Speech gRPC service. Supports Piper for fast CPU synthesis, Kokoro for GPU synthesis, and ChatterBox for multilingual voices.',
    color: '#f472b6',
  },
};

export function ArchitectureDiagram(): React.ReactElement {
  const [activeComponent, setActiveComponent] = useState<string | null>(null);
  const activeInfo = activeComponent ? componentDetails[activeComponent] : null;

  const isActive = (id: string) => activeComponent === id;
  const getStroke = (id1: string, id2?: string) =>
    isActive(id1) || (id2 && isActive(id2)) ? '#a855f7' : '#52525b';
  const getMarker = (id1: string, id2?: string) =>
    isActive(id1) || (id2 && isActive(id2)) ? 'url(#arrow-active)' : 'url(#arrow)';

  const Box = ({ id, x, y, w, h }: { id: string; x: number; y: number; w: number; h: number }) => {
    const comp = componentDetails[id];
    const active = isActive(id);
    return (
      <g
        onMouseEnter={() => setActiveComponent(id)}
        onMouseLeave={() => setActiveComponent(null)}
        style={{ cursor: 'pointer' }}
      >
        <rect
          x={x} y={y} width={w} height={h} rx="8"
          fill={active ? comp.color : 'rgba(28, 25, 23, 0.9)'}
          stroke={comp.color}
          strokeWidth={active ? 2.5 : 1.5}
        />
        <text
          x={x + w/2} y={y + h/2 - (comp.sublabel ? 4 : 0)}
          fill={active ? '#fff' : '#fafafa'}
          fontSize="11" fontWeight="600" textAnchor="middle"
        >
          {comp.label}
        </text>
        {comp.sublabel && (
          <text
            x={x + w/2} y={y + h/2 + 10}
            fill={active ? 'rgba(255,255,255,0.8)' : '#71717a'}
            fontSize="7" textAnchor="middle" fontFamily="monospace"
          >
            {comp.sublabel}
          </text>
        )}
      </g>
    );
  };

  return (
    <div className="architecture-diagram">
      <svg viewBox="0 0 680 300" className="architecture-diagram__svg">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#52525b" />
          </marker>
          <marker id="arrow-active" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#a855f7" />
          </marker>
        </defs>

        {/* ==================== LIVEKIT (TOP EXTERNAL) ==================== */}
        <rect x="265" y="5" width="150" height="50" rx="6"
          fill="rgba(245, 158, 11, 0.05)" stroke="#f59e0b" strokeWidth="1" strokeDasharray="4,2" />
        <text x="340" y="18" fill="#f59e0b" fontSize="8" textAnchor="middle" fontWeight="500">External</text>
        <Box id="livekit" x={280} y={22} w={120} h={28} />

        {/* ==================== USER (LEFT EXTERNAL) ==================== */}
        <rect x="5" y="80" width="70" height="90" rx="6"
          fill="rgba(34, 197, 94, 0.05)" stroke="#22c55e" strokeWidth="1" strokeDasharray="4,2" />
        <text x="40" y="93" fill="#22c55e" fontSize="8" textAnchor="middle" fontWeight="500">External</text>
        <Box id="user" x={12} y={100} w={56} h={60} />

        {/* ==================== LLM (RIGHT EXTERNAL) ==================== */}
        <rect x="605" y="80" width="70" height="90" rx="6"
          fill="rgba(139, 92, 246, 0.05)" stroke="#8b5cf6" strokeWidth="1" strokeDasharray="4,2" />
        <text x="640" y="93" fill="#8b5cf6" fontSize="8" textAnchor="middle" fontWeight="500">External</text>
        <Box id="llm" x={612} y={100} w={56} h={60} />

        {/* ==================== KUBERNETES CLUSTER ==================== */}
        <rect x="85" y="65" width="510" height="230" rx="10"
          fill="rgba(59, 130, 246, 0.02)" stroke="#3b82f6" strokeWidth="1.5" />
        <text x="340" y="82" fill="#3b82f6" fontSize="10" textAnchor="middle" fontWeight="600">
          Kubernetes Cluster
        </text>

        {/* Namespace */}
        <rect x="95" y="92" width="490" height="195" rx="6"
          fill="transparent" stroke="rgba(59, 130, 246, 0.2)" strokeWidth="1" strokeDasharray="4,3" />
        <text x="340" y="106" fill="#52525b" fontSize="8" textAnchor="middle" fontFamily="monospace">
          namespace: ai-agents
        </text>

        {/* Main flow row: Frontend → Backend → Agent */}
        <Box id="frontend" x={110} y={120} w={95} h={45} />
        <Box id="backend" x={240} y={120} w={95} h={45} />
        <Box id="agent" x={430} y={115} w={110} h={55} />

        {/* Bottom row: PostgreSQL (under Backend), STT + TTS (under Agent) */}
        <Box id="postgres" x={240} y={200} w={95} h={45} />
        <Box id="stt" x={365} y={210} w={95} h={40} />
        <Box id="tts" x={475} y={210} w={95} h={40} />

        {/* ==================== CONNECTIONS ==================== */}

        {/* User → Frontend */}
        <line x1="68" y1="130" x2="110" y2="140"
          stroke={getStroke('user', 'frontend')} strokeWidth="1.5" markerEnd={getMarker('user', 'frontend')} />
        <text x="82" y="127" fill="#71717a" fontSize="7">HTTP</text>

        {/* User ↔ LiveKit */}
        <path d="M 40 100 L 40 60 Q 40 36 60 36 L 280 36" fill="none"
          stroke={getStroke('user', 'livekit')} strokeWidth="1.5" markerEnd={getMarker('user', 'livekit')} />
        <text x="150" y="30" fill="#71717a" fontSize="7">WebRTC</text>

        {/* Frontend → Backend */}
        <line x1="205" y1="142" x2="240" y2="142"
          stroke={getStroke('frontend', 'backend')} strokeWidth="1.5" markerEnd={getMarker('frontend', 'backend')} />
        <text x="222" y="136" fill="#71717a" fontSize="7">REST</text>

        {/* Backend → PostgreSQL */}
        <line x1="287" y1="165" x2="287" y2="200"
          stroke={getStroke('backend', 'postgres')} strokeWidth="1.5" markerEnd={getMarker('backend', 'postgres')} />
        <text x="298" y="185" fill="#71717a" fontSize="7">Prisma</text>

        {/* Backend → Agent (K8s API) */}
        <line x1="335" y1="142" x2="430" y2="142"
          stroke={getStroke('backend', 'agent')} strokeWidth="1.5" markerEnd={getMarker('backend', 'agent')} />
        <text x="380" y="136" fill="#71717a" fontSize="7">K8s API</text>

        {/* LiveKit ↔ Agent */}
        <path d="M 400 36 L 485 36 Q 510 36 510 60 L 510 115" fill="none"
          stroke={getStroke('livekit', 'agent')} strokeWidth="1.5" markerEnd={getMarker('livekit', 'agent')} />
        <text x="455" y="30" fill="#71717a" fontSize="7">Audio</text>

        {/* Agent → LLM */}
        <line x1="540" y1="142" x2="612" y2="130"
          stroke={getStroke('agent', 'llm')} strokeWidth="1.5" markerEnd={getMarker('agent', 'llm')} />
        <text x="570" y="128" fill="#71717a" fontSize="7">API</text>

        {/* Agent → STT */}
        <line x1="460" y1="170" x2="413" y2="210"
          stroke={getStroke('agent', 'stt')} strokeWidth="1.5" markerEnd={getMarker('agent', 'stt')} />
        <text x="428" y="192" fill="#71717a" fontSize="7">gRPC</text>

        {/* Agent → TTS */}
        <line x1="510" y1="170" x2="523" y2="210"
          stroke={getStroke('agent', 'tts')} strokeWidth="1.5" markerEnd={getMarker('agent', 'tts')} />
        <text x="525" y="192" fill="#71717a" fontSize="7">gRPC</text>

      </svg>

      {/* Info panel */}
      <div className={`architecture-diagram__info ${activeInfo ? 'architecture-diagram__info--visible' : ''}`}>
        {activeInfo ? (
          <>
            <div className="architecture-diagram__info-badge" style={{ backgroundColor: activeInfo.color }}>
              {activeInfo.label}
              {activeInfo.sublabel && (
                <span style={{ opacity: 0.8, marginLeft: '8px', fontSize: '0.85em' }}>
                  {activeInfo.sublabel}
                </span>
              )}
            </div>
            <p className="architecture-diagram__info-description">{activeInfo.description}</p>
          </>
        ) : (
          <p className="architecture-diagram__info-hint">Hover over a component to see details</p>
        )}
      </div>
    </div>
  );
}

export default ArchitectureDiagram;
