import { useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useThemeStore } from '../../store/themeStore'
import type { PipelineSchema, AgentConfigurationPayload } from '../../lib/api-types'
import PipelineNodeCardComponent from './PipelineNodeCard'
import type { StageSummary } from './PipelineNodeCard'

// Horizontal layout spacing
const COL_SPACING = 340
const ROW_SPACING = 200
const X_OFFSET = 80
const Y_OFFSET = 80

// Annotation node offsets
const INPUT_ANNOTATION_X = X_OFFSET - 200
const OUTPUT_ANNOTATION_X_PAD = 70 // added after last column

interface PipelineViewProps {
  schema: PipelineSchema
  configuration: AgentConfigurationPayload
  selectedNodeId: string | null
  onNodeClick: (nodeId: string) => void
  onPaneClick?: () => void
  /** Per-node stage summaries for hybrid display */
  stageSummaries?: Record<string, StageSummary>
}

const nodeTypes = {
  pipeline: PipelineNodeCardComponent,
}

export default function PipelineView({ schema, configuration, selectedNodeId, onNodeClick, onPaneClick, stageSummaries }: PipelineViewProps) {
  const { resolvedTheme } = useThemeStore()
  const isDark = resolvedTheme === 'dark'

  // Find the max column for output annotation placement
  const maxCol = useMemo(() => Math.max(...schema.nodes.map((n) => n.position.col)), [schema.nodes])
  const maxRow = useMemo(() => Math.max(...schema.nodes.map((n) => n.position.row)), [schema.nodes])

  // Center annotations vertically between all rows
  const annotationY = Y_OFFSET + (maxRow * ROW_SPACING) / 2

  const nodes: Node[] = useMemo(() => {
    const pipelineNodes: Node[] = schema.nodes.map((n) => {
      const nodeConfig = configuration.nodes?.[n.id]
      const isModified = nodeConfig && Object.keys(nodeConfig).length > 0

      return {
        id: n.id,
        type: 'pipeline',
        position: {
          x: X_OFFSET + n.position.col * COL_SPACING,
          y: Y_OFFSET + n.position.row * ROW_SPACING,
        },
        data: {
          label: n.label,
          icon: n.icon,
          description: n.description,
          nodeId: n.id,
          isModified,
          isSelected: selectedNodeId === n.id,
          isDark,
          stageSummary: stageSummaries?.[n.id],
        },
        draggable: false,
        selectable: true,
      }
    })

    // Add input annotation node (before first column, vertically centered)
    pipelineNodes.push({
      id: '__input__',
      type: 'pipeline',
      position: { x: INPUT_ANNOTATION_X, y: annotationY },
      data: {
        label: 'Input Message',
        isAnnotation: true,
        annotationType: 'input',
        isDark,
      },
      draggable: false,
      selectable: false,
      focusable: false,
    })

    // Add output annotation node (after last column, vertically centered)
    pipelineNodes.push({
      id: '__output__',
      type: 'pipeline',
      position: { x: X_OFFSET + maxCol * COL_SPACING + 210 + OUTPUT_ANNOTATION_X_PAD, y: annotationY },
      data: {
        label: 'Output Message',
        isAnnotation: true,
        annotationType: 'output',
        isDark,
      },
      draggable: false,
      selectable: false,
      focusable: false,
    })

    // This evaluator's own endpoints — it lives on a separate runtime path, not
    // in the turn pipeline. Its input is a message TYPED mid-turn; spoken
    // interruptions bypass it entirely and are decided from VAD speech duration
    // in the SDK. Styled like the Input/Output Message annotations and aligned
    // on the node's row above the pipeline.
    const bargeInNode = schema.nodes.find((n) => n.id === 'barge_in')
    if (bargeInNode) {
      const bargeInY = Y_OFFSET + bargeInNode.position.row * ROW_SPACING
      pipelineNodes.push({
        id: '__bargein_input__',
        type: 'pipeline',
        position: { x: INPUT_ANNOTATION_X, y: bargeInY },
        data: {
          label: 'Typed interruption',
          isAnnotation: true,
          annotationType: 'input',
          isDark,
        },
        draggable: false,
        selectable: false,
        focusable: false,
      })
      pipelineNodes.push({
        id: '__bargein_output__',
        type: 'pipeline',
        position: { x: X_OFFSET + maxCol * COL_SPACING + 210 + OUTPUT_ANNOTATION_X_PAD, y: bargeInY },
        data: {
          label: 'Commit / Resume',
          isAnnotation: true,
          annotationType: 'output',
          isDark,
        },
        draggable: false,
        selectable: false,
        focusable: false,
      })
    }

    // Session-end interrupt — the terminal counterpart to barge-in. Like barge-in it
    // runs on a separate path (the backend session_end signal), not the turn pipeline,
    // so give it its own input endpoint (the session-end trigger) and output endpoint
    // (the spoken farewell + self-disconnect), aligned on its own row.
    const interruptNode = schema.nodes.find((n) => n.id === 'interrupt_handler')
    if (interruptNode) {
      const interruptY = Y_OFFSET + interruptNode.position.row * ROW_SPACING
      pipelineNodes.push({
        id: '__interrupt_input__',
        type: 'pipeline',
        position: { x: INPUT_ANNOTATION_X, y: interruptY },
        data: {
          label: 'Session End',
          isAnnotation: true,
          annotationType: 'input',
          isDark,
        },
        draggable: false,
        selectable: false,
        focusable: false,
      })
      pipelineNodes.push({
        id: '__interrupt_output__',
        type: 'pipeline',
        position: { x: X_OFFSET + maxCol * COL_SPACING + 210 + OUTPUT_ANNOTATION_X_PAD, y: interruptY },
        data: {
          label: 'Farewell / Close',
          isAnnotation: true,
          annotationType: 'output',
          isDark,
        },
        draggable: false,
        selectable: false,
        focusable: false,
      })
    }

    return pipelineNodes
  }, [schema.nodes, configuration, selectedNodeId, isDark, maxCol, annotationY])

  // Find the first node (col=0, row=0) and last node (max col, row=0)
  const firstNodeId = useMemo(
    () => schema.nodes.find((n) => n.position.col === 0 && n.position.row === 0)?.id || schema.nodes[0]?.id,
    [schema.nodes],
  )
  const lastNodeId = useMemo(
    () => schema.nodes.find((n) => n.position.col === maxCol && n.position.row === 0)?.id || schema.nodes[schema.nodes.length - 1]?.id,
    [schema.nodes, maxCol],
  )

  const edgeLabelColor = isDark ? '#71717a' : '#a1a1aa'
  const annotationEdgeColor = isDark ? '#3f3f46' : '#e5e5e5'
  const dashedEdgeColor = isDark ? '#52525b' : '#c4c4c8'

  const edges: Edge[] = useMemo(() => {
    const pipelineEdges: Edge[] = schema.edges.map((e, i) => {
      return {
        id: `edge-${i}`,
        source: e.source,
        target: e.target,
        sourceHandle: 'right',
        targetHandle: 'left',
        label: e.label,
        type: 'default',
        animated: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: dashedEdgeColor,
        },
        style: {
          stroke: dashedEdgeColor,
          strokeWidth: 1.5,
          strokeDasharray: '6 4',
        },
        labelStyle: {
          fontSize: 7,
          fill: edgeLabelColor,
          fontWeight: 400,
          fontFamily: 'ui-monospace, monospace',
          letterSpacing: '0.02em',
        },
        labelBgStyle: {
          fill: isDark ? '#18181b' : '#ffffff',
          fillOpacity: 0.9,
        },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      }
    })

    // Input annotation → first pipeline node
    pipelineEdges.push({
      id: 'edge-input',
      source: '__input__',
      target: firstNodeId,
      targetHandle: 'left',
      type: 'default',
      animated: false,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: annotationEdgeColor,
      },
      style: {
        stroke: annotationEdgeColor,
        strokeWidth: 1.5,
        strokeDasharray: '6 4',
      },
    })

    // Input annotation → bridge_generator (parallel fork)
    const bridgeNode = schema.nodes.find((n) => n.id === 'bridge_generator')
    if (bridgeNode) {
      pipelineEdges.push({
        id: 'edge-input-bridge',
        source: '__input__',
        target: 'bridge_generator',
        targetHandle: 'left',
        type: 'default',
        animated: false,
        label: 'parallel',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: annotationEdgeColor,
        },
        style: {
          stroke: annotationEdgeColor,
          strokeWidth: 1.5,
          strokeDasharray: '6 4',
        },
        labelStyle: {
          fontSize: 7,
          fill: isDark ? '#52525b' : '#a1a1aa',
          fontWeight: 400,
          fontStyle: 'italic',
        },
        labelBgStyle: {
          fill: isDark ? '#18181b' : '#ffffff',
          fillOpacity: 0.9,
        },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      })
    }

    // Last pipeline node → output annotation
    pipelineEdges.push({
      id: 'edge-output',
      source: lastNodeId,
      sourceHandle: 'right',
      target: '__output__',
      type: 'default',
      animated: false,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: annotationEdgeColor,
      },
      style: {
        stroke: annotationEdgeColor,
        strokeWidth: 1.5,
        strokeDasharray: '6 4',
      },
    })

    // Bridge generator → output annotation (early TTS)
    if (bridgeNode) {
      pipelineEdges.push({
        id: 'edge-bridge-output',
        source: 'bridge_generator',
        sourceHandle: 'right',
        target: '__output__',
        type: 'default',
        animated: false,
        label: 'bridge phrase',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: dashedEdgeColor,
        },
        style: {
          stroke: dashedEdgeColor,
          strokeWidth: 1.5,
          strokeDasharray: '6 4',
        },
        labelStyle: {
          fontSize: 7,
          fill: edgeLabelColor,
          fontWeight: 400,
          fontStyle: 'italic',
        },
        labelBgStyle: {
          fill: isDark ? '#18181b' : '#ffffff',
          fillOpacity: 0.9,
        },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      })
    }

    // Barge-in evaluator: sits above the pipeline and spans the whole turn.
    // Visualize its input (the user's interruption) and output (the
    // commit/resume decision that controls playback), mirroring the bridge.
    const bargeInNode = schema.nodes.find((n) => n.id === 'barge_in')
    if (bargeInNode) {
      // Dedicated input endpoint (SDK interruption) → evaluator.
      pipelineEdges.push({
        id: 'edge-bargein-input',
        source: '__bargein_input__',
        target: 'barge_in',
        targetHandle: 'left',
        type: 'default',
        animated: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: annotationEdgeColor,
        },
        style: {
          stroke: annotationEdgeColor,
          strokeWidth: 1.5,
          strokeDasharray: '6 4',
        },
      })
      // Evaluator → dedicated output endpoint (commit/resume decision).
      pipelineEdges.push({
        id: 'edge-bargein-output',
        source: 'barge_in',
        sourceHandle: 'right',
        target: '__bargein_output__',
        type: 'default',
        animated: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: annotationEdgeColor,
        },
        style: {
          stroke: annotationEdgeColor,
          strokeWidth: 1.5,
          strokeDasharray: '6 4',
        },
      })
    }

    // Session-end interrupt: trigger endpoint → handler → farewell/close endpoint.
    const interruptNode = schema.nodes.find((n) => n.id === 'interrupt_handler')
    if (interruptNode) {
      pipelineEdges.push({
        id: 'edge-interrupt-input',
        source: '__interrupt_input__',
        target: 'interrupt_handler',
        targetHandle: 'left',
        type: 'default',
        animated: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: annotationEdgeColor,
        },
        style: {
          stroke: annotationEdgeColor,
          strokeWidth: 1.5,
          strokeDasharray: '6 4',
        },
      })
      pipelineEdges.push({
        id: 'edge-interrupt-output',
        source: 'interrupt_handler',
        sourceHandle: 'right',
        target: '__interrupt_output__',
        type: 'default',
        animated: false,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: annotationEdgeColor,
        },
        style: {
          stroke: annotationEdgeColor,
          strokeWidth: 1.5,
          strokeDasharray: '6 4',
        },
      })
    }

    return pipelineEdges
  }, [schema.edges, schema.nodes, isDark, edgeLabelColor, dashedEdgeColor, annotationEdgeColor, firstNodeId, lastNodeId])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Don't handle clicks on annotation nodes
      if (node.id.startsWith('__')) return
      onNodeClick(node.id)
    },
    [onNodeClick],
  )

  return (
    <div className={`w-full h-full ${isDark ? 'bg-surface-dark' : 'bg-surface'}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.25, minZoom: 0.5, maxZoom: 1.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        panOnDrag={true}
        zoomOnScroll={false}
        zoomOnPinch={true}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        {/* Blueprint-style grid background */}
        <Background
          variant={BackgroundVariant.Lines}
          color={isDark ? 'rgba(168,85,247,0.06)' : 'rgba(0,0,0,0.04)'}
          gap={24}
          lineWidth={0.5}
        />
        <Background
          id="coarse"
          variant={BackgroundVariant.Lines}
          color={isDark ? 'rgba(168,85,247,0.10)' : 'rgba(0,0,0,0.07)'}
          gap={24 * 5}
          lineWidth={1}
        />
      </ReactFlow>
    </div>
  )
}
