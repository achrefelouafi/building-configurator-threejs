import * as THREE from 'three/webgpu';
import { float, mix, mrt, normalView, output, pass, uniform, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { denoise } from 'three/examples/jsm/tsl/display/DenoiseNode.js';
import BloomNode, { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { ArchitecturalStyle, LightingPreset, MassingState } from '../core/types';
import { PBRMaterialLibrary, TextureLoadProgress } from '../building/materials';
import { generatePBRBuilding } from '../building/buildingGenerator';

export type GPUBackendKind = 'WebGPU' | 'WebGL2';

export interface BuildingLoadSnapshot {
  gpuReady: boolean;
  gpuBackend: GPUBackendKind | null;
  texturesLoaded: number;
  texturesTotal: number;
  hdrisLoaded: number;
  hdrisTotal: number;
  currentAsset: string;
  warmedUp: boolean;
}

export interface BuildingViewportCallbacks {
  onBackendReady?: (backend: GPUBackendKind) => void;
  onHdriLoading?: (loading: boolean) => void;
  onLoadSnapshot?: (snapshot: BuildingLoadSnapshot) => void;
}

interface LightingTheme {
  hdriUrl: string;
  fallbackBg: string;
  sunColor: string;
  sunIntensity: number;
  sunPosition: [number, number, number];
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  envIntensity: number;
  bgIntensity: number;
  fogColor: string;
  fogDensity: number;
  exposure: number;
  bloomStrength: number;
  bloomThreshold: number;
}

const ALL_LIGHTING_PRESETS: LightingPreset[] = ['golden-hour', 'daylight', 'twilight'];

const LIGHTING_THEMES: Record<LightingPreset, LightingTheme> = {
  'golden-hour': {
    hdriUrl: '/hdri/golden_hour.hdr',
    fallbackBg: '#c79776',
    sunColor: '#ffd4a3',
    sunIntensity: 4.4,
    sunPosition: [44, 18, 28],
    hemiSky: '#a8c6eb',
    hemiGround: '#3d332c',
    hemiIntensity: 0.22,
    envIntensity: 1.15,
    bgIntensity: 1.0,
    fogColor: '#cf9e7c',
    fogDensity: 0.0011,
    exposure: 1.05,
    bloomStrength: 0.16,
    bloomThreshold: 1.18,
  },
  daylight: {
    hdriUrl: '/hdri/daylight.hdr',
    fallbackBg: '#a9cce8',
    sunColor: '#fffbf2',
    sunIntensity: 4.5,
    sunPosition: [32, 48, 34],
    hemiSky: '#cfe5ff',
    hemiGround: '#4a5058',
    hemiIntensity: 0.25,
    envIntensity: 1.1,
    bgIntensity: 1.0,
    fogColor: '#c8dceb',
    fogDensity: 0.0009,
    exposure: 0.98,
    bloomStrength: 0.12,
    bloomThreshold: 1.28,
  },
  twilight: {
    hdriUrl: '/hdri/twilight.hdr',
    fallbackBg: '#17233b',
    sunColor: '#8eb2eb',
    sunIntensity: 0.95,
    sunPosition: [-32, 16, -26],
    hemiSky: '#37548c',
    hemiGround: '#0e131e',
    hemiIntensity: 0.22,
    envIntensity: 0.9,
    bgIntensity: 0.92,
    fogColor: '#1b2945',
    fogDensity: 0.0022,
    exposure: 1.14,
    bloomStrength: 0.34,
    bloomThreshold: 1.02,
  },
};

export class BuildingViewport {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;

  private container: HTMLElement;
  private renderer: THREE.WebGPURenderer;
  private scene: THREE.Scene;
  private callbacks: BuildingViewportCallbacks;
  private materialLib: PBRMaterialLibrary;
  private rgbeLoader = new RGBELoader();
  private hdriCache = new Map<LightingPreset, THREE.DataTexture>();

  private sunLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;

  // WebGPU TSL Post-Processing (GTAO Ambient Occlusion + Bilateral Denoise + Physical HDR Bloom)
  private postProcessing: THREE.PostProcessing | null = null;
  private aoStrengthUniform = uniform(0.75);
  private bloomPass: BloomNode | null = null;
  private postFXEnabled = true;
  private postFXFailed = false;

  private buildingRoot = new THREE.Group();
  private currentBounds = new THREE.Box3();
  private currentStyle: ArchitecturalStyle = 'contemporary';
  private currentLighting: LightingPreset = 'golden-hour';
  private showColumns = true;
  private showSite = true;
  private lastState: MassingState | null = null;

  private resizeObserver: ResizeObserver;
  private initialized = false;
  private disposed = false;

  private loadState: BuildingLoadSnapshot = {
    gpuReady: false,
    gpuBackend: null,
    texturesLoaded: 0,
    texturesTotal: 43,
    hdrisLoaded: 0,
    hdrisTotal: ALL_LIGHTING_PRESETS.length,
    currentAsset: 'Initializing WebGPU backend…',
    warmedUp: false,
  };
  private warmupFramesRemaining = 3;

  constructor(container: HTMLElement, callbacks: BuildingViewportCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(LIGHTING_THEMES['golden-hour'].fallbackBg);
    this.scene.backgroundBlurriness = 0.012;

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.25, 450);
    this.camera.position.set(22, 18, 25);

    this.renderer = new THREE.WebGPURenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.492;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 145;
    this.controls.target.set(0, 4.5, 0);
    this.controls.update();

    this.materialLib = new PBRMaterialLibrary(8, (p: TextureLoadProgress) => {
      if (this.disposed) return;
      this.loadState.texturesLoaded = p.loaded;
      this.loadState.texturesTotal = p.total;
      if (p.lastUrl) {
        this.loadState.currentAsset = p.lastUrl;
      }
      this.emitLoadSnapshot();
    });

    // High-contrast architectural daylight rig paired with 2K Poly Haven HDRI IBL
    this.hemiLight = new THREE.HemisphereLight('#a8c6eb', '#3d332c', 0.22);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight('#ffd4a3', 4.4);
    this.sunLight.position.set(44, 18, 28);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(4096, 4096);
    this.sunLight.shadow.bias = -0.00025;
    this.sunLight.shadow.normalBias = 0.025;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.scene.add(this.buildingRoot);

    this.applyLightingPreset(this.currentLighting);
    this.preloadAllHdris();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    void this.renderer.init().then(() => {
      if (this.disposed) {
        this.renderer.dispose();
        return;
      }
      this.initialized = true;
      this.handleResize();
      this.setupPostProcessing();

      const isWebGPU = Boolean(
        (this.renderer.backend as unknown as { isWebGPUBackend?: boolean })?.isWebGPUBackend
      );
      const backend: GPUBackendKind = isWebGPU ? 'WebGPU' : 'WebGL2';
      this.loadState.gpuReady = true;
      this.loadState.gpuBackend = backend;
      this.callbacks.onBackendReady?.(backend);
      this.emitLoadSnapshot();
      this.renderer.setAnimationLoop(this.renderFrame);
    });
  }

  /**
   * Configures Three.js WebGPU TSL Post-Processing:
   * - Multi-Render-Target beauty + view-space normal + depth pass
   * - Real-time Ground-Truth Ambient Occlusion (GTAO) at architectural meter scale
   * - Edge-preserving Bilateral Denoiser
   * - Physical HDR Bloom for mirror glass sun glints & warm architectural LEDs
   */
  private setupPostProcessing(): void {
    try {
      const theme = LIGHTING_THEMES[this.currentLighting];
      const scenePass = pass(this.scene, this.camera);
      scenePass.setMRT(
        mrt({
          output,
          normal: normalView,
        })
      );

      const scenePassColor = scenePass.getTextureNode('output');
      const scenePassNormal = scenePass.getTextureNode('normal');
      const scenePassDepth = scenePass.getTextureNode('depth');

      const aoPass = ao(scenePassDepth, scenePassNormal, this.camera);
      aoPass.resolutionScale = 0.5;
      aoPass.radius.value = 1.45;
      aoPass.distanceExponent.value = 1.6;
      aoPass.thickness.value = 1.25;
      aoPass.scale.value = 1.35;
      aoPass.samples.value = 16;

      const denoisePass = denoise(
        aoPass.getTextureNode(),
        scenePassDepth,
        scenePassNormal,
        this.camera
      );
      denoisePass.radius.value = 5;
      denoisePass.lumaPhi.value = 5;
      denoisePass.depthPhi.value = 5;
      denoisePass.normalPhi.value = 5;

      // Apply denoised GTAO cleanly to RGB channels only, preserving full sky & alpha
      const aoFactor = mix(float(1.0), denoisePass.r, this.aoStrengthUniform);
      const litWithAO = vec4(scenePassColor.rgb.mul(aoFactor), scenePassColor.a);

      const bloomPass = bloom(litWithAO, theme.bloomStrength, 0.35, theme.bloomThreshold);
      this.bloomPass = bloomPass;

      const pp = new THREE.PostProcessing(this.renderer);
      pp.outputNode = litWithAO.add(bloomPass);
      this.postProcessing = pp;
    } catch {
      this.postProcessing = null;
      this.postFXFailed = true;
    }
  }

  public setPostFXEnabled(enabled: boolean): void {
    this.postFXEnabled = enabled;
    this.aoStrengthUniform.value = enabled ? 0.75 : 0.0;
    if (this.bloomPass) {
      const theme = LIGHTING_THEMES[this.currentLighting];
      this.bloomPass.strength.value = enabled ? theme.bloomStrength : 0.0;
    }
  }

  private emitLoadSnapshot(): void {
    this.callbacks.onLoadSnapshot?.({ ...this.loadState });
  }

  private preloadAllHdris(): void {
    this.callbacks.onHdriLoading?.(true);
    let completed = 0;

    for (const preset of ALL_LIGHTING_PRESETS) {
      const theme = LIGHTING_THEMES[preset];
      this.rgbeLoader.load(
        theme.hdriUrl,
        (hdrTex) => {
          if (this.disposed) {
            hdrTex.dispose();
            return;
          }
          hdrTex.mapping = THREE.EquirectangularReflectionMapping;
          this.hdriCache.set(preset, hdrTex);

          if (preset === this.currentLighting) {
            this.scene.environment = hdrTex;
            this.scene.background = hdrTex;
            this.materialLib.setEnvironmentMap(hdrTex);
            this.callbacks.onHdriLoading?.(false);
          }

          completed++;
          this.loadState.hdrisLoaded = completed;
          this.loadState.currentAsset = theme.hdriUrl;
          this.emitLoadSnapshot();
        },
        undefined,
        () => {
          if (this.disposed) return;
          completed++;
          this.loadState.hdrisLoaded = completed;
          if (preset === this.currentLighting) {
            this.callbacks.onHdriLoading?.(false);
          }
          this.emitLoadSnapshot();
        }
      );
    }
  }

  public applyLightingPreset(preset: LightingPreset): void {
    this.currentLighting = preset;
    const theme = LIGHTING_THEMES[preset];

    this.sunLight.color.set(theme.sunColor);
    this.sunLight.intensity = theme.sunIntensity;
    this.sunLight.position.set(...theme.sunPosition);

    this.hemiLight.color.set(theme.hemiSky);
    this.hemiLight.groundColor.set(theme.hemiGround);
    this.hemiLight.intensity = theme.hemiIntensity;

    this.scene.environmentIntensity = theme.envIntensity;
    this.scene.backgroundIntensity = theme.bgIntensity;
    this.scene.fog = new THREE.FogExp2(theme.fogColor, theme.fogDensity);
    this.renderer.toneMappingExposure = theme.exposure;

    if (this.bloomPass) {
      this.bloomPass.strength.value = this.postFXEnabled ? theme.bloomStrength : 0.0;
      this.bloomPass.threshold.value = theme.bloomThreshold;
    }

    const cached = this.hdriCache.get(preset);
    if (cached) {
      this.scene.environment = cached;
      this.scene.background = cached;
      this.materialLib.setEnvironmentMap(cached);
      this.callbacks.onHdriLoading?.(false);
    } else {
      this.scene.background = new THREE.Color(theme.fallbackBg);
      this.callbacks.onHdriLoading?.(true);
    }

    this.materialLib.updateLightingResponse(this.currentStyle, preset);
    this.fitShadowCamera();
  }

  public updateBuilding(
    state: MassingState,
    style: ArchitecturalStyle,
    showColumns: boolean,
    showSite: boolean
  ): void {
    this.lastState = state;
    this.currentStyle = style;
    this.showColumns = showColumns;
    this.showSite = showSite;

    while (this.buildingRoot.children.length > 0) {
      const child = this.buildingRoot.children[0];
      this.buildingRoot.remove(child);
      child.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) {
          (obj as THREE.Mesh).geometry.dispose();
        }
      });
    }

    const palette = this.materialLib.getPalette(style);
    this.materialLib.updateLightingResponse(style, this.currentLighting);

    const { group, bounds } = generatePBRBuilding(state, palette, {
      style,
      showColumns,
      showSite,
    });

    this.buildingRoot.add(group);
    this.currentBounds.copy(bounds);
    this.fitShadowCamera();
  }

  public setStyle(style: ArchitecturalStyle): void {
    if (this.lastState) {
      this.updateBuilding(this.lastState, style, this.showColumns, this.showSite);
    } else {
      this.currentStyle = style;
    }
  }

  private fitShadowCamera(): void {
    const center = new THREE.Vector3(0, 4, 0);
    const size = new THREE.Vector3(24, 16, 24);
    if (!this.currentBounds.isEmpty()) {
      this.currentBounds.getCenter(center);
      this.currentBounds.getSize(size);
    }

    const radius = Math.max(22, size.length() * 0.72 + 12);
    const theme = LIGHTING_THEMES[this.currentLighting];
    const sunDir = new THREE.Vector3(...theme.sunPosition).normalize();

    this.sunLight.target.position.copy(center);
    this.sunLight.position.copy(center).addScaledVector(sunDir, radius * 1.65);

    const cam = this.sunLight.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 1;
    cam.far = radius * 4.5;
    cam.updateProjectionMatrix();
  }

  private handleResize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private renderFrame = (): void => {
    if (this.disposed || !this.initialized) return;
    this.controls.update();

    if (this.postProcessing && this.postFXEnabled && !this.postFXFailed) {
      try {
        this.postProcessing.render();
      } catch {
        this.postFXFailed = true;
        this.renderer.render(this.scene, this.camera);
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    if (
      !this.loadState.warmedUp &&
      this.loadState.gpuReady &&
      this.loadState.texturesLoaded >= this.loadState.texturesTotal &&
      this.loadState.hdrisLoaded >= this.loadState.hdrisTotal &&
      this.buildingRoot.children.length > 0
    ) {
      this.warmupFramesRemaining--;
      if (this.warmupFramesRemaining <= 0) {
        this.loadState.warmedUp = true;
        this.loadState.currentAsset = 'Scene ready';
        this.emitLoadSnapshot();
      }
    }
  };

  public dispose(): void {
    this.disposed = true;
    this.resizeObserver.disconnect();
    while (this.buildingRoot.children.length > 0) {
      const child = this.buildingRoot.children[0];
      this.buildingRoot.remove(child);
      child.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      });
    }
    for (const tex of this.hdriCache.values()) {
      tex.dispose();
    }
    this.hdriCache.clear();
    this.materialLib.dispose();
    this.controls.dispose();
    this.postProcessing = null;
    if (this.initialized) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
    }
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
