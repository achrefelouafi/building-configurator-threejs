import React, { useEffect, useState } from 'react';
import { Building2, Check, Loader2 } from 'lucide-react';
import { BuildingLoadSnapshot } from '../viewports/BuildingViewport';

interface LoadingOverlayProps {
  massingReady: boolean;
  snapshot: BuildingLoadSnapshot;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  massingReady,
  snapshot,
}) => {
  const gpuDone = massingReady && snapshot.gpuReady;
  const texturesDone =
    snapshot.texturesTotal > 0 && snapshot.texturesLoaded >= snapshot.texturesTotal;
  const hdrisDone = snapshot.hdrisTotal > 0 && snapshot.hdrisLoaded >= snapshot.hdrisTotal;
  const allReady = gpuDone && texturesDone && hdrisDone && snapshot.warmedUp;

  const gpuFrac = (massingReady ? 0.5 : 0) + (snapshot.gpuReady ? 0.5 : 0);
  const texFrac =
    snapshot.texturesTotal > 0
      ? Math.min(1, snapshot.texturesLoaded / snapshot.texturesTotal)
      : 0;
  const hdriFrac =
    snapshot.hdrisTotal > 0 ? Math.min(1, snapshot.hdrisLoaded / snapshot.hdrisTotal) : 0;
  const warmupFrac = snapshot.warmedUp ? 1 : 0;

  const progress = Math.round(
    gpuFrac * 15 + texFrac * 50 + hdriFrac * 30 + warmupFrac * 5
  );

  const [fading, setFading] = useState(false);
  const [unmounted, setUnmounted] = useState(false);

  useEffect(() => {
    if (!allReady) return;
    const t1 = window.setTimeout(() => setFading(true), 220);
    const t2 = window.setTimeout(() => setUnmounted(true), 720);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [allReady]);

  if (unmounted) return null;

  return (
    <div
      className={`loader-overlay ${fading ? 'fading' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Loading 3D building configurator assets"
    >
      <div className="loader-grid-bg" />

      <div className="loader-card">
        <div className="loader-header">
          <div className="loader-logo">
            <Building2 size={22} />
          </div>
          <div>
            <div className="loader-title">VOLUMECRAFT</div>
            <div className="loader-subtitle">
              Parametric Massing Studio · WebGPU PBR Engine
            </div>
          </div>
        </div>

        <div className="loader-bar-wrap">
          <div className="loader-bar-meta">
            <span className="loader-status-text">
              {allReady ? 'Studio Ready' : 'Preloading PBR Materials & HDRI Skies…'}
            </span>
            <span className="loader-percent">{progress}%</span>
          </div>
          <div className="loader-track">
            <div className="loader-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="loader-steps">
          <div className={`loader-step ${gpuDone ? 'done' : 'active'}`}>
            <span className="loader-step-icon">
              {gpuDone ? <Check size={13} /> : <Loader2 size={13} className="spin" />}
            </span>
            <span className="loader-step-label">Dual 3D Viewports</span>
            <span className="loader-step-detail">
              {snapshot.gpuBackend ? snapshot.gpuBackend : 'Initializing…'}
            </span>
          </div>

          <div className={`loader-step ${texturesDone ? 'done' : 'active'}`}>
            <span className="loader-step-icon">
              {texturesDone ? <Check size={13} /> : <Loader2 size={13} className="spin" />}
            </span>
            <span className="loader-step-label">AmbientCG PBR Maps</span>
            <span className="loader-step-detail">
              {snapshot.texturesLoaded} / {snapshot.texturesTotal}
            </span>
          </div>

          <div className={`loader-step ${hdrisDone ? 'done' : 'active'}`}>
            <span className="loader-step-icon">
              {hdrisDone ? <Check size={13} /> : <Loader2 size={13} className="spin" />}
            </span>
            <span className="loader-step-label">Poly Haven 2K HDRI Skies</span>
            <span className="loader-step-detail">
              {snapshot.hdrisLoaded} / {snapshot.hdrisTotal}
            </span>
          </div>

          <div className={`loader-step ${snapshot.warmedUp ? 'done' : gpuDone && texturesDone && hdrisDone ? 'active' : ''}`}>
            <span className="loader-step-icon">
              {snapshot.warmedUp ? <Check size={13} /> : <Loader2 size={13} className="spin" />}
            </span>
            <span className="loader-step-label">Shader & GPU Pipeline Warmup</span>
            <span className="loader-step-detail">
              {snapshot.warmedUp ? 'Compiled' : 'Pending'}
            </span>
          </div>
        </div>

        <div className="loader-current-asset" title={snapshot.currentAsset}>
          {snapshot.currentAsset}
        </div>
      </div>
    </div>
  );
};
