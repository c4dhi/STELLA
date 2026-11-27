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

    // A step off the turn's chain (#224) gets its own input and output on its
    // row, styled like the Input/Output Message annotations: barge-in (a typed
    // interruption in, commit/resume out), session end (farewell out). What the
    // ends are called is the agent's declaration (`path`), not a node id.
    for (const n of schema.nodes) {
      if (n.path?.kind !== 'side') continue
      const y = Y_OFFSET + n.position.row * ROW_SPACING
      const annotation = (end: 'input' | 'output', x: number): Node => ({
        id: `__${n.id}_${end}__`,
        type: 'pipeline',
        position: { x, y },
        data: { label: n.path![end], isAnnotation: true, annotationType: end, isDark },
        draggable: false,
        selectable: false,
        focusable: false,
      })
      pipelineNodes.push(annotation('input', INPUT_ANNOTATION_X))
      pipelineNodes.push(annotation('output', X_OFFSET + maxCol * COL_SPACING + 210 + OUTPUT_ANNOTATION_X_PAD))
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

    // A `parallel` step (#224) is fed by the turn's input and feeds its output,
    // like a bridge phrase spoken while the turn is still worked on; a `side`
    // step runs between its own two ends. Both are the agent's declaration.
    const plainEdge = (id: string, source: string, target: string): Edge => ({
      id,
      source,
      target,
      sourceHandle: 'right',
      targetHandle: 'left',
      type: 'default',
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: annotationEdgeColor },
      style: { stroke: annotationEdgeColor, strokeWidth: 1.5, strokeDasharray: '6 4' },
    })
    const labelled = (edge: Edge, label: string, color: string): Edge => ({
      ...edge,
      label,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: { stroke: color, strokeWidth: 1.5, strokeDasharray: '6 4' },
      labelStyle: { fontSize: 7, fill: isDark ? '#52525b' : '#a1a1aa', fontWeight: 400, fontStyle: 'italic' },
      labelBgStyle: { fill: isDark ? '#18181b' : '#ffffff', fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
    })
    for (const n of schema.nodes) {
      if (n.path?.kind === 'parallel') {
        pipelineEdges.push(labelled(plainEdge(`edge-${n.id}-input`, '__input__', n.id), n.path.input, annotationEdgeColor))
        pipelineEdges.push(labelled(plainEdge(`edge-${n.id}-output`, n.id, '__output__'), n.path.output, dashedEdgeColor))
      } else if (n.path?.kind === 'side') {
        pipelineEdges.push(plainEdge(`edge-${n.id}-input`, `__${n.id}_input__`, n.id))
        pipelineEdges.push(plainEdge(`edge-${n.id}-output`, n.id, `__${n.id}_output__`))
      }
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
        // minZoom lowered from 0.5 (#970): on a narrow canvas (tablet/phone,
        // the sidebar now stacking below rather than beside it) fitting every
        // stage needs to zoom out further than that. fitView only zooms out
        // as far as it needs to, so this is a no-op at desktop widths.
        fitViewOptions={{ padding: 0.25, minZoom: 0.25, maxZoom: 1.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        panOnDrag={true}
        zoomOnScroll={false}
        zoomOnPinch={true}
        minZoom={0.2}
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
