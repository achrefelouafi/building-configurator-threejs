import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import {
  ArchitecturalStyle,
  DragPreviewInfo,
  LightingPreset,
  MassingFace,
  MassingState,
  SplitAxis,
  ToolMode,
} from './core/types';
import {
  applyExtrude,
  applyInsetFace,
  applySplitFace,
  computeBuildingStats,
  computeExposedFaces,
  createDefaultMassing,
  createPresetMassing,
} from './core/massingEngine';
import { dirLabel } from './core/math2d';
import { MassingViewport } from './viewports/MassingViewport';
import {
  BuildingLoadSnapshot,
  BuildingViewport,
  GPUBackendKind,
} from './viewports/BuildingViewport';
import { CameraSyncManager } from './viewports/CameraSync';
import { SplitPane } from './components/SplitPane';
import { MassingPresetKey, TopBar } from './components/TopBar';
import { MassingToolbar } from './components/MassingToolbar';
import { BuildingControls } from './components/BuildingControls';
import { LoadingOverlay } from './components/LoadingOverlay';

const INITIAL_LOAD_SNAPSHOT: BuildingLoadSnapshot = {
  gpuReady: false,
  gpuBackend: null,
  texturesLoaded: 0,
  texturesTotal: 43,
  hdrisLoaded: 0,
  hdrisTotal: 3,
  currentAsset: 'Initializing WebGPU backend…',
  warmedUp: false,
};

interface HistoryState {
  past: MassingState[];
  present: MassingState;
  future: MassingState[];
}

function findTopFaceId(state: MassingState): string | null {
  const faces = computeExposedFaces(state);
  const topFaces = faces.filter((f) => f.dir === '+y' && !f.locked);
  if (topFaces.length === 0) return null;
  topFaces.sort((a, b) => b.plane - a.plane);
  return topFaces[0].id;
}

export const App: React.FC = () => {
  const initialMassing = useMemo(() => createDefaultMassing(), []);

  const [history, setHistory] = useState<HistoryState>(() => ({
    past: [],
    present: initialMassing,
    future: [],
  }));
  const [selectedFaceId, setSelectedFaceId] = useState<string | null>(() =>
    findTopFaceId(initialMassing)
  );
  const [hoveredFace, setHoveredFace] = useState<MassingFace | null>(null);
  const [dragInfo, setDragInfo] = useState<DragPreviewInfo | null>(null);
  const [activePreset, setActivePreset] = useState<MassingPresetKey | null>('box');

  // CAD tool states
  const [toolMode, setToolMode] = useState<ToolMode>('extrude');
  const [splitAxis, setSplitAxis] = useState<SplitAxis>('auto');
  const [floorSnap, setFloorSnap] = useState<boolean>(true);

  // ArchViz PBR states
  const [style, setStyle] = useState<ArchitecturalStyle>('contemporary');
  const [lighting, setLighting] = useState<LightingPreset>('golden-hour');
  const [showColumns, setShowColumns] = useState<boolean>(true);
  const [showSite, setShowSite] = useState<boolean>(true);
  const [postFX, setPostFX] = useState<boolean>(true);
  const [cameraSync, setCameraSync] = useState<boolean>(true);
  const [gpuBackend, setGpuBackend] = useState<GPUBackendKind | null>(null);
  const [hdriLoading, setHdriLoading] = useState<boolean>(true);
  const [massingReady, setMassingReady] = useState<boolean>(false);
  const [loadSnapshot, setLoadSnapshot] = useState<BuildingLoadSnapshot>(INITIAL_LOAD_SNAPSHOT);

  // Live preview state during drag (updates right PBR view in real time)
  const [previewState, setPreviewState] = useState<MassingState | null>(null);

  const leftHostRef = useRef<HTMLDivElement | null>(null);
  const rightHostRef = useRef<HTMLDivElement | null>(null);
  const massingVpRef = useRef<MassingViewport | null>(null);
  const buildingVpRef = useRef<BuildingViewport | null>(null);
  const syncRef = useRef<CameraSyncManager | null>(null);

  // Latest state ref for viewport callbacks
  const stateRef = useRef<MassingState>(history.present);
  stateRef.current = history.present;

  const commitState = useCallback((next: MassingState, nextFocusFaceId: string | null) => {
    setHistory((h) => ({
      past: [...h.past.slice(-49), h.present],
      present: next,
      future: [],
    }));
    setActivePreset(null);
    setSelectedFaceId(nextFocusFaceId);
  }, []);

  const handleCommitExtrude = useCallback(
    (face: MassingFace, distance: number, insetMargin: number) => {
      const res = applyExtrude(stateRef.current, face, distance, insetMargin);
      if (res.state !== stateRef.current) {
        commitState(res.state, res.newFaceId);
      }
    },
    [commitState]
  );

  const handleCommitSplit = useCallback(
    (face: MassingFace, axis: SplitAxis, ratio: number) => {
      const res = applySplitFace(stateRef.current, face, axis, ratio);
      if (res.state !== stateRef.current) {
        commitState(res.state, res.newFaceId);
        // Switch back to Extrude right after splitting? Keep user in Split if they want multiple cuts,
        // or select the first split piece cleanly.
      }
    },
    [commitState]
  );

  const handleCommitInset = useCallback(
    (face: MassingFace, margin: number) => {
      const res = applyInsetFace(stateRef.current, face, margin);
      if (res.state !== stateRef.current) {
        commitState(res.state, res.newFaceId);
        // Auto-switch to Extrude so the user can immediately pull the newly inset inner face!
        setToolMode('extrude');
      }
    },
    [commitState]
  );

  // Mount Vanilla Three.js Viewports + Camera Sync
  useEffect(() => {
    if (!leftHostRef.current || !rightHostRef.current) return;

    setMassingReady(false);
    setLoadSnapshot(INITIAL_LOAD_SNAPSHOT);

    const massingVp = new MassingViewport(leftHostRef.current, {
      onReady: () => setMassingReady(true),
      onSelectFace: (face) => setSelectedFaceId(face ? face.id : null),
      onHoverFace: (face) => setHoveredFace(face),
      onPreviewState: (preview) => setPreviewState(preview),
      onDragInfo: (info) => setDragInfo(info),
      onCommitExtrude: handleCommitExtrude,
      onCommitSplit: handleCommitSplit,
      onCommitInset: handleCommitInset,
    });

    const buildingVp = new BuildingViewport(rightHostRef.current, {
      onBackendReady: (backend) => setGpuBackend(backend),
      onHdriLoading: (loading) => setHdriLoading(loading),
      onLoadSnapshot: (snap) => setLoadSnapshot(snap),
    });
    const sync = new CameraSyncManager(massingVp, buildingVp, true);

    massingVpRef.current = massingVp;
    buildingVpRef.current = buildingVp;
    syncRef.current = sync;

    return () => {
      sync.dispose();
      massingVp.dispose();
      buildingVp.dispose();
      syncRef.current = null;
      massingVpRef.current = null;
      buildingVpRef.current = null;
    };
  }, [handleCommitExtrude, handleCommitInset, handleCommitSplit]);

  // Sync massing state to Left CAD Viewport
  useEffect(() => {
    massingVpRef.current?.setMassingState(history.present, selectedFaceId);
  }, [history.present, selectedFaceId]);

  useEffect(() => {
    massingVpRef.current?.setToolMode(toolMode);
  }, [toolMode]);

  useEffect(() => {
    massingVpRef.current?.setSplitAxis(splitAxis);
  }, [splitAxis]);

  useEffect(() => {
    massingVpRef.current?.setFloorSnap(floorSnap);
  }, [floorSnap]);

  // Sync live massing (or live drag preview!) + style to Right PBR Building Viewport
  const activeBuildingState = previewState ?? history.present;
  useEffect(() => {
    buildingVpRef.current?.updateBuilding(activeBuildingState, style, showColumns, showSite);
  }, [activeBuildingState, style, showColumns, showSite]);

  useEffect(() => {
    buildingVpRef.current?.applyLightingPreset(lighting);
  }, [lighting]);

  useEffect(() => {
    buildingVpRef.current?.setPostFXEnabled(postFX);
  }, [postFX]);

  useEffect(() => {
    syncRef.current?.setEnabled(cameraSync);
  }, [cameraSync]);

  // Derived exposed faces & live building metrics
  const exposedFaces = useMemo(() => computeExposedFaces(history.present), [history.present]);
  const selectedFace = useMemo(
    () => exposedFaces.find((f) => f.id === selectedFaceId && !f.locked) ?? null,
    [exposedFaces, selectedFaceId]
  );

  const stats = useMemo(() => {
    const activeFaces = previewState ? computeExposedFaces(previewState) : exposedFaces;
    return computeBuildingStats(
      activeBuildingState,
      activeFaces.filter((f) => !f.locked).length
    );
  }, [activeBuildingState, exposedFaces, previewState]);

  const handleUndo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const previous = h.past[h.past.length - 1];
      setSelectedFaceId(findTopFaceId(previous));
      setActivePreset(null);
      return {
        past: h.past.slice(0, -1),
        present: previous,
        future: [h.present, ...h.future],
      };
    });
  }, []);

  const handleRedo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0];
      setSelectedFaceId(findTopFaceId(next));
      setActivePreset(null);
      return {
        past: [...h.past, h.present],
        present: next,
        future: h.future.slice(1),
      };
    });
  }, []);

  const handleSelectPreset = useCallback((preset: MassingPresetKey) => {
    const next = createPresetMassing(preset);
    setHistory((h) => ({
      past: [...h.past.slice(-49), h.present],
      present: next,
      future: [],
    }));
    setActivePreset(preset);
    setSelectedFaceId(findTopFaceId(next));
    setToolMode('extrude');
  }, []);

  const handleResetCamera = useCallback(() => {
    syncRef.current?.resetBoth(new THREE.Vector3(0, 5, 0), new THREE.Vector3(24, 19, 27));
  }, []);

  const handleQuickExtrude = useCallback(
    (distance: number, insetMargin = 0) => {
      if (!selectedFace) return;
      handleCommitExtrude(selectedFace, distance, insetMargin);
    },
    [selectedFace, handleCommitExtrude]
  );

  const handleQuickSplit = useCallback(() => {
    if (!selectedFace) return;
    handleCommitSplit(selectedFace, splitAxis, 0.5);
  }, [selectedFace, splitAxis, handleCommitSplit]);

  const handleQuickInset = useCallback(() => {
    if (!selectedFace) return;
    handleCommitInset(selectedFace, 1.6);
  }, [selectedFace, handleCommitInset]);

  // Global keyboard shortcuts (E, S, K, I, Ctrl+Z, Ctrl+Y)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (key === 'e') setToolMode('extrude');
      else if (key === 's') setToolMode('setback');
      else if (key === 'k') setToolMode('split');
      else if (key === 'i') setToolMode('inset');
      else if (key === 'g') setFloorSnap((v) => !v);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleRedo, handleUndo]);

  return (
    <div className="app-shell">
      <LoadingOverlay massingReady={massingReady} snapshot={loadSnapshot} />

      <TopBar
        activePreset={activePreset}
        stats={stats}
        cameraSync={cameraSync}
        onSelectPreset={handleSelectPreset}
        onToggleCameraSync={() => setCameraSync((v) => !v)}
        onResetCamera={handleResetCamera}
      />

      <SplitPane
        left={
          <>
            <div ref={leftHostRef} className="viewport-canvas-host" />

            <div className="viewport-header">
              <div className="view-badge">
                <span className="view-dot cad" />
                <span className="view-badge-title">MASSING STUDIO</span>
                <span className="view-badge-sub">Programmatic Face Extrusion</span>
              </div>

              {hoveredFace && !dragInfo && (
                <div className="hover-pill">
                  {dirLabel(hoveredFace.dir)} · {hoveredFace.width.toFixed(1)}×
                  {hoveredFace.height.toFixed(1)}m
                </div>
              )}
            </div>

            {dragInfo && dragInfo.active && (
              <div
                className={`drag-badge ${
                  dragInfo.isCarve ? 'carve' : dragInfo.isSetback ? 'setback' : 'extrude'
                }`}
                style={{ left: dragInfo.screenX, top: dragInfo.screenY }}
              >
                {dragInfo.label}
              </div>
            )}

            <MassingToolbar
              toolMode={toolMode}
              splitAxis={splitAxis}
              floorSnap={floorSnap}
              canUndo={history.past.length > 0}
              canRedo={history.future.length > 0}
              selectedFace={selectedFace}
              onToolChange={setToolMode}
              onSplitAxisChange={setSplitAxis}
              onToggleFloorSnap={() => setFloorSnap((v) => !v)}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onResetBox={() => handleSelectPreset('box')}
              onQuickExtrude={handleQuickExtrude}
              onQuickSplit={handleQuickSplit}
              onQuickInset={handleQuickInset}
            />
          </>
        }
        right={
          <>
            <div ref={rightHostRef} className="viewport-canvas-host" />

            <div className="viewport-header">
              <div className="view-badge">
                <span className="view-dot pbr" />
                <span className="view-badge-title">ARCHITECTURAL PBR</span>
                <span className="view-badge-sub">AmbientCG + HDRI</span>
              </div>

              <div className="right-status-pills">
                {hdriLoading && <span className="status-pill loading">Loading HDRI…</span>}
                {gpuBackend && (
                  <span className={`status-pill ${gpuBackend === 'WebGPU' ? 'webgpu' : 'webgl'}`}>
                    <span className="status-dot" />
                    {gpuBackend}
                  </span>
                )}
              </div>
            </div>

            <BuildingControls
              style={style}
              lighting={lighting}
              showColumns={showColumns}
              showSite={showSite}
              postFX={postFX}
              onStyleChange={setStyle}
              onLightingChange={setLighting}
              onToggleColumns={() => setShowColumns((v) => !v)}
              onToggleSite={() => setShowSite((v) => !v)}
              onTogglePostFX={() => setPostFX((v) => !v)}
            />
          </>
        }
      />
    </div>
  );
};

export default App;
