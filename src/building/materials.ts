import * as THREE from 'three/webgpu';
import { ArchitecturalStyle, LightingPreset } from '../core/types';
import { createBotanicalLeafSprigTextures, FoliageTextureMaps } from './foliageGenerator';

interface LoadedACGSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  aoMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
}

export interface TextureLoadProgress {
  loaded: number;
  total: number;
  lastUrl: string;
}

export interface BuildingMaterialPalette {
  facadePrimary: THREE.MeshStandardMaterial;
  facadeSecondary: THREE.MeshStandardMaterial;
  plinth: THREE.MeshStandardMaterial;
  mullion: THREE.MeshStandardMaterial;
  accentMetal: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  spandrelGlass: THREE.MeshPhysicalMaterial;
  balustradeGlass: THREE.MeshPhysicalMaterial;
  interiorWall: THREE.MeshStandardMaterial;
  interiorCeiling: THREE.MeshStandardMaterial;
  interiorFloor: THREE.MeshStandardMaterial;
  roofDeck: THREE.MeshStandardMaterial;
  terracePaver: THREE.MeshStandardMaterial;
  soffitWood: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  solarPanel: THREE.MeshPhysicalMaterial;
  emissiveWarm: THREE.MeshStandardMaterial;
  emissiveCool: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  bark: THREE.MeshStandardMaterial;
  plazaPaver: THREE.MeshStandardMaterial;
  asphalt: THREE.MeshStandardMaterial;
}

/**
 * Loads and manages 12 real CC0 photographic PBR texture sets from AmbientCG:
 * - Concrete048 (Brushed pale limestone/architectural precast), Bricks051 (Kiln-fired brick)
 * - Travertine009 (Roman travertine), Concrete016 (Cast architectural concrete & honed interior floors)
 * - Concrete017 (Dark honed basalt/concrete plinth), Plaster001 (Matte architectural interior plaster)
 * - WoodFloor040 (Warm cedar soffits), Metal049A (Brushed anodized metal w/ metalness map)
 * - PavingStones128 (Stone plaza & terrace pavers), Concrete034 (Roof deck)
 * - Asphalt031 (Urban street), Bark014 (Scanned botanical tree bark)
 * Paired with untextured physical exterior-reflective plate glass & botanical leaf sprigs.
 */
export class PBRMaterialLibrary {
  private loader = new THREE.TextureLoader();
  private allLoadedTextures: THREE.Texture[] = [];
  private loadedCount = 0;
  private totalCount = 0;
  private queuingDone = false;
  private onProgress?: (progress: TextureLoadProgress) => void;
  private activeEnvMap: THREE.Texture | null = null;

  private limestoneTex: LoadedACGSet;
  private brickTex: LoadedACGSet;
  private travertineTex: LoadedACGSet;
  private concreteTex: LoadedACGSet;
  private graniteTex: LoadedACGSet;
  private plasterTex: LoadedACGSet;
  private timberTex: LoadedACGSet;
  private metalTex: LoadedACGSet;
  private paverTex: LoadedACGSet;
  private roofTex: LoadedACGSet;
  private asphaltTex: LoadedACGSet;
  private barkTex: LoadedACGSet;

  private leafSprigTex: FoliageTextureMaps;
  private palettes = new Map<ArchitecturalStyle, BuildingMaterialPalette>();

  constructor(anisotropy = 8, onProgress?: (progress: TextureLoadProgress) => void) {
    this.onProgress = onProgress;
    this.limestoneTex = this.loadACGSet('limestone', { aniso: anisotropy, hasAO: true });
    this.brickTex = this.loadACGSet('brick', { aniso: anisotropy });
    this.travertineTex = this.loadACGSet('travertine', { aniso: anisotropy, hasAO: true });
    this.concreteTex = this.loadACGSet('concrete', { aniso: anisotropy });
    this.graniteTex = this.loadACGSet('granite', { aniso: anisotropy });
    this.plasterTex = this.loadACGSet('plaster', { aniso: anisotropy });
    this.timberTex = this.loadACGSet('timber', { aniso: anisotropy, hasAO: true });
    this.metalTex = this.loadACGSet('metal', { aniso: anisotropy, hasMetalness: true });
    this.paverTex = this.loadACGSet('paver', { aniso: anisotropy, hasAO: true });
    this.roofTex = this.loadACGSet('roof', { aniso: anisotropy });
    this.asphaltTex = this.loadACGSet('asphalt', { aniso: anisotropy, hasAO: true });
    this.barkTex = this.loadACGSet('bark', { aniso: anisotropy, hasAO: true });

    this.leafSprigTex = createBotanicalLeafSprigTextures(anisotropy);
    this.queuingDone = true;
    this.onProgress?.({ loaded: this.loadedCount, total: this.totalCount, lastUrl: '' });
  }

  private loadMap(url: string, isColor: boolean, aniso: number): THREE.Texture {
    this.totalCount++;
    const markDone = () => {
      this.loadedCount++;
      if (this.queuingDone) {
        this.onProgress?.({ loaded: this.loadedCount, total: this.totalCount, lastUrl: url });
      }
    };
    const tex = this.loader.load(url, markDone, undefined, markDone);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = aniso;
    tex.generateMipmaps = true;
    this.allLoadedTextures.push(tex);
    return tex;
  }

  private loadACGSet(
    folder: string,
    opts: { aniso: number; hasAO?: boolean; hasMetalness?: boolean }
  ): LoadedACGSet {
    const base = `/textures/${folder}`;
    const set: LoadedACGSet = {
      map: this.loadMap(`${base}/color.jpg`, true, opts.aniso),
      normalMap: this.loadMap(`${base}/normal.jpg`, false, opts.aniso),
      roughnessMap: this.loadMap(`${base}/roughness.jpg`, false, opts.aniso),
    };
    if (opts.hasAO) {
      set.aoMap = this.loadMap(`${base}/ao.jpg`, false, opts.aniso);
    }
    if (opts.hasMetalness) {
      set.metalnessMap = this.loadMap(`${base}/metalness.jpg`, false, opts.aniso);
    }
    return set;
  }

  /**
   * Explicitly binds the active HDRI texture to reflective materials so Three.js WebGPU
   * honors per-material envMapIntensity for true mirror-like architectural glass reflections.
   */
  public setEnvironmentMap(envMap: THREE.Texture | null): void {
    this.activeEnvMap = envMap;
    for (const p of this.palettes.values()) {
      this.applyEnvMapToPalette(p, envMap);
    }
  }

  private applyEnvMapToPalette(p: BuildingMaterialPalette, envMap: THREE.Texture | null): void {
    const targets: (THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial)[] = [
      p.glass,
      p.spandrelGlass,
      p.balustradeGlass,
      p.mullion,
      p.accentMetal,
      p.solarPanel,
      p.interiorFloor,
    ];
    for (const mat of targets) {
      mat.envMap = envMap;
      mat.needsUpdate = true;
    }
  }

  getPalette(style: ArchitecturalStyle): BuildingMaterialPalette {
    let p = this.palettes.get(style);
    if (p) return p;

    const common = this.createCommonMaterials();

    if (style === 'contemporary') {
      p = {
        ...common,
        facadePrimary: new THREE.MeshStandardMaterial({
          map: this.limestoneTex.map,
          normalMap: this.limestoneTex.normalMap,
          normalScale: new THREE.Vector2(0.75, 0.75),
          roughnessMap: this.limestoneTex.roughnessMap,
          aoMap: this.limestoneTex.aoMap,
          aoMapIntensity: 0.72,
          roughness: 0.92,
          metalness: 0.02,
          color: new THREE.Color('#f4f1ea'),
        }),
        facadeSecondary: new THREE.MeshStandardMaterial({
          map: this.concreteTex.map,
          normalMap: this.concreteTex.normalMap,
          normalScale: new THREE.Vector2(0.65, 0.65),
          roughnessMap: this.concreteTex.roughnessMap,
          roughness: 0.9,
          metalness: 0.04,
          color: new THREE.Color('#dcdfe4'),
        }),
        mullion: new THREE.MeshStandardMaterial({
          map: this.metalTex.map,
          normalMap: this.metalTex.normalMap,
          normalScale: new THREE.Vector2(0.35, 0.35),
          roughnessMap: this.metalTex.roughnessMap,
          metalnessMap: this.metalTex.metalnessMap,
          roughness: 0.36,
          metalness: 0.92,
          envMapIntensity: 1.5,
          color: new THREE.Color('#232830'),
        }),
        accentMetal: new THREE.MeshStandardMaterial({
          map: this.metalTex.map,
          normalMap: this.metalTex.normalMap,
          normalScale: new THREE.Vector2(0.35, 0.35),
          roughnessMap: this.metalTex.roughnessMap,
          metalnessMap: this.metalTex.metalnessMap,
          roughness: 0.32,
          metalness: 0.94,
          envMapIntensity: 1.65,
          color: new THREE.Color('#cbbba2'),
        }),
        // Untextured real physical exterior-reflective plate glass (low opacity + high mirror HDR reflection)
        glass: new THREE.MeshPhysicalMaterial({
          color: new THREE.Color('#0c1824'),
          metalness: 0.52,
          roughness: 0.015,
          ior: 1.52,
          reflectivity: 1.0,
          specularIntensity: 1.0,
          clearcoat: 1.0,
          clearcoatRoughness: 0.008,
          transparent: true,
          opacity: 0.38,
          envMapIntensity: 3.6,
          depthWrite: false,
        }),
      };
    } else if (style === 'brick-loft') {
      p = {
        ...common,
        facadePrimary: new THREE.MeshStandardMaterial({
          map: this.brickTex.map,
          normalMap: this.brickTex.normalMap,
          normalScale: new THREE.Vector2(1.2, 1.2),
          roughnessMap: this.brickTex.roughnessMap,
          roughness: 1.0,
          metalness: 0.02,
          color: new THREE.Color('#ded5cc'),
        }),
        facadeSecondary: new THREE.MeshStandardMaterial({
          map: this.limestoneTex.map,
          normalMap: this.limestoneTex.normalMap,
          normalScale: new THREE.Vector2(0.8, 0.8),
          roughnessMap: this.limestoneTex.roughnessMap,
          aoMap: this.limestoneTex.aoMap,
          aoMapIntensity: 0.7,
          roughness: 0.92,
          metalness: 0.03,
          color: new THREE.Color('#d6cfc4'),
        }),
        mullion: new THREE.MeshStandardMaterial({
          map: this.metalTex.map,
          normalMap: this.metalTex.normalMap,
          roughnessMap: this.metalTex.roughnessMap,
          metalnessMap: this.metalTex.metalnessMap,
          roughness: 0.42,
          metalness: 0.88,
          envMapIntensity: 1.35,
          color: new THREE.Color('#1f2228'),
        }),
        accentMetal: new THREE.MeshStandardMaterial({
          map: this.metalTex.map,
          normalMap: this.metalTex.normalMap,
          roughnessMap: this.metalTex.roughnessMap,
          metalnessMap: this.metalTex.metalnessMap,
          roughness: 0.44,
          metalness: 0.88,
          envMapIntensity: 1.35,
          color: new THREE.Color('#4a3c32'),
        }),
        glass: new THREE.MeshPhysicalMaterial({
          color: new THREE.Color('#101920'),
          metalness: 0.46,
          roughness: 0.018,
          ior: 1.52,
          reflectivity: 1.0,
          specularIntensity: 1.0,
          clearcoat: 1.0,
          clearcoatRoughness: 0.01,
          transparent: true,
          opacity: 0.34,
          envMapIntensity: 3.3,
          depthWrite: false,
        }),
      };
    } else {
      // travertine-bronze
      p = {
        ...common,
        facadePrimary: new THREE.MeshStandardMaterial({
          map: this.travertineTex.map,
          normalMap: this.travertineTex.normalMap,
          normalScale: new THREE.Vector2(1.0, 1.0),
          roughnessMap: this.travertineTex.roughnessMap,
          aoMap: this.travertineTex.aoMap,
          aoMapIntensity: 0.78,
          roughness: 0.96,
          metalness: 0.02,
          color: new THREE.Color('#f0e8db'),
        }),
        facadeSecondary: new THREE.MeshStandardMaterial({
          map: this.travertineTex.map,
          normalMap: this.travertineTex.normalMap,
          roughnessMap: this.travertineTex.roughnessMap,
          aoMap: this.travertineTex.aoMap,
          aoMapIntensity: 0.72,
          roughness: 0.94,
          metalness: 0.03,
          color: new THREE.Color('#d4c5ae'),
        }),
        mullion: new THREE.MeshStandardMaterial({
          map: this.metalTex.map,
          normalMap: this.metalTex.normalMap,
          roughnessMap: this.metalTex.roughnessMap,
          metalnessMap: this.metalTex.metalnessMap,
          roughness: 0.34,
          metalness: 0.94,
          envMapIntensity: 1.65,
          color: new THREE.Color('#5a412a'),
        }),
        accentMetal: new THREE.MeshStandardMaterial({
          map: this.metalTex.map,
          normalMap: this.metalTex.normalMap,
          roughnessMap: this.metalTex.roughnessMap,
          metalnessMap: this.metalTex.metalnessMap,
          roughness: 0.28,
          metalness: 0.95,
          envMapIntensity: 1.85,
          color: new THREE.Color('#bd9159'),
        }),
        glass: new THREE.MeshPhysicalMaterial({
          color: new THREE.Color('#1a1612'),
          metalness: 0.54,
          roughness: 0.015,
          ior: 1.52,
          reflectivity: 1.0,
          specularIntensity: 1.0,
          clearcoat: 1.0,
          clearcoatRoughness: 0.008,
          transparent: true,
          opacity: 0.38,
          envMapIntensity: 3.6,
          depthWrite: false,
        }),
      };
    }

    if (this.activeEnvMap) {
      this.applyEnvMapToPalette(p, this.activeEnvMap);
    }

    this.palettes.set(style, p);
    return p;
  }

  private createCommonMaterials() {
    return {
      plinth: new THREE.MeshStandardMaterial({
        map: this.graniteTex.map,
        normalMap: this.graniteTex.normalMap,
        normalScale: new THREE.Vector2(0.75, 0.75),
        roughnessMap: this.graniteTex.roughnessMap,
        roughness: 0.78,
        metalness: 0.06,
        color: new THREE.Color('#595e66'),
      }),
      spandrelGlass: new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#091018'),
        metalness: 0.84,
        roughness: 0.03,
        clearcoat: 1.0,
        clearcoatRoughness: 0.015,
        reflectivity: 1.0,
        envMapIntensity: 2.8,
      }),
      balustradeGlass: new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#132430'),
        metalness: 0.32,
        roughness: 0.02,
        clearcoat: 1.0,
        clearcoatRoughness: 0.01,
        transparent: true,
        opacity: 0.26,
        envMapIntensity: 2.5,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      // Real hollow 3D interior shell materials (clean architectural plaster & honed floor)
      interiorWall: new THREE.MeshStandardMaterial({
        map: this.plasterTex.map,
        normalMap: this.plasterTex.normalMap,
        normalScale: new THREE.Vector2(0.35, 0.35),
        roughnessMap: this.plasterTex.roughnessMap,
        roughness: 0.94,
        metalness: 0.0,
        color: new THREE.Color('#ebe6dd'),
      }),
      interiorCeiling: new THREE.MeshStandardMaterial({
        map: this.plasterTex.map,
        normalMap: this.plasterTex.normalMap,
        normalScale: new THREE.Vector2(0.25, 0.25),
        roughnessMap: this.plasterTex.roughnessMap,
        roughness: 0.96,
        metalness: 0.0,
        color: new THREE.Color('#f4f1ea'),
      }),
      interiorFloor: new THREE.MeshStandardMaterial({
        map: this.concreteTex.map,
        normalMap: this.concreteTex.normalMap,
        normalScale: new THREE.Vector2(0.4, 0.4),
        roughnessMap: this.concreteTex.roughnessMap,
        roughness: 0.36,
        metalness: 0.06,
        envMapIntensity: 0.95,
        color: new THREE.Color('#cfc7bb'),
      }),
      roofDeck: new THREE.MeshStandardMaterial({
        map: this.roofTex.map,
        normalMap: this.roofTex.normalMap,
        normalScale: new THREE.Vector2(0.95, 0.95),
        roughnessMap: this.roofTex.roughnessMap,
        roughness: 1.0,
        metalness: 0.03,
        color: new THREE.Color('#b6b9be'),
      }),
      terracePaver: new THREE.MeshStandardMaterial({
        map: this.paverTex.map,
        normalMap: this.paverTex.normalMap,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughnessMap: this.paverTex.roughnessMap,
        aoMap: this.paverTex.aoMap,
        aoMapIntensity: 0.78,
        roughness: 1.0,
        metalness: 0.02,
        color: new THREE.Color('#e6e0d5'),
      }),
      soffitWood: new THREE.MeshStandardMaterial({
        map: this.timberTex.map,
        normalMap: this.timberTex.normalMap,
        normalScale: new THREE.Vector2(1.05, 1.05),
        roughnessMap: this.timberTex.roughnessMap,
        aoMap: this.timberTex.aoMap,
        aoMapIntensity: 0.85,
        roughness: 0.82,
        metalness: 0.03,
        color: new THREE.Color('#cfa882'),
      }),
      concrete: new THREE.MeshStandardMaterial({
        map: this.concreteTex.map,
        normalMap: this.concreteTex.normalMap,
        normalScale: new THREE.Vector2(0.75, 0.75),
        roughnessMap: this.concreteTex.roughnessMap,
        roughness: 0.92,
        metalness: 0.04,
        color: new THREE.Color('#cccfd4'),
      }),
      solarPanel: new THREE.MeshPhysicalMaterial({
        color: new THREE.Color('#0c172b'),
        metalness: 0.52,
        roughness: 0.1,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        envMapIntensity: 2.2,
      }),
      emissiveWarm: new THREE.MeshStandardMaterial({
        color: new THREE.Color('#fff6e5'),
        emissive: new THREE.Color('#ffc97d'),
        emissiveIntensity: 2.2,
        roughness: 0.2,
      }),
      emissiveCool: new THREE.MeshStandardMaterial({
        color: new THREE.Color('#eef7ff'),
        emissive: new THREE.Color('#b8dcff'),
        emissiveIntensity: 1.0,
        roughness: 0.25,
      }),
      foliage: new THREE.MeshStandardMaterial({
        map: this.leafSprigTex.map,
        normalMap: this.leafSprigTex.normalMap,
        normalScale: new THREE.Vector2(0.65, 0.65),
        roughnessMap: this.leafSprigTex.roughnessMap,
        roughness: 0.76,
        metalness: 0.0,
        alphaTest: 0.42,
        side: THREE.DoubleSide,
        vertexColors: true,
      }),
      bark: new THREE.MeshStandardMaterial({
        map: this.barkTex.map,
        normalMap: this.barkTex.normalMap,
        normalScale: new THREE.Vector2(1.25, 1.25),
        roughnessMap: this.barkTex.roughnessMap,
        aoMap: this.barkTex.aoMap,
        aoMapIntensity: 0.85,
        roughness: 1.0,
        metalness: 0.0,
        color: new THREE.Color('#c2b29f'),
      }),
      plazaPaver: new THREE.MeshStandardMaterial({
        map: this.paverTex.map,
        normalMap: this.paverTex.normalMap,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: this.paverTex.roughnessMap,
        aoMap: this.paverTex.aoMap,
        aoMapIntensity: 0.78,
        roughness: 1.0,
        metalness: 0.02,
        color: new THREE.Color('#d8d2c8'),
      }),
      asphalt: new THREE.MeshStandardMaterial({
        map: this.asphaltTex.map,
        normalMap: this.asphaltTex.normalMap,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: this.asphaltTex.roughnessMap,
        aoMap: this.asphaltTex.aoMap,
        aoMapIntensity: 0.75,
        roughness: 1.0,
        metalness: 0.02,
        color: new THREE.Color('#8e949e'),
      }),
    };
  }

  updateLightingResponse(style: ArchitecturalStyle, preset: LightingPreset): void {
    const p = this.getPalette(style);
    if (preset === 'twilight') {
      // Warm lit hollow 3D interiors glow vividly through crisp dusk sky reflections
      p.emissiveWarm.emissiveIntensity = 4.5;
      p.interiorCeiling.emissive.set('#ffcf8c');
      p.interiorCeiling.emissiveIntensity = 0.55;
      p.interiorWall.emissive.set('#e8b272');
      p.interiorWall.emissiveIntensity = 0.28;
      p.interiorFloor.emissive.set('#c49058');
      p.interiorFloor.emissiveIntensity = 0.16;
      p.glass.opacity = 0.26;
      p.glass.metalness = 0.42;
      p.glass.envMapIntensity = 2.4;
    } else if (preset === 'golden-hour') {
      p.emissiveWarm.emissiveIntensity = 2.2;
      p.interiorCeiling.emissive.set('#ffe4be');
      p.interiorCeiling.emissiveIntensity = 0.16;
      p.interiorWall.emissive.set('#f2d7b4');
      p.interiorWall.emissiveIntensity = 0.06;
      p.interiorFloor.emissive.set('#000000');
      p.interiorFloor.emissiveIntensity = 0.0;
      p.glass.opacity = 0.36;
      p.glass.metalness = 0.52;
      p.glass.envMapIntensity = 3.8;
    } else {
      // daylight: ultra-crisp exterior mirror reflection of clouds + clear sunlit hollow interior
      p.emissiveWarm.emissiveIntensity = 0.9;
      p.interiorCeiling.emissive.set('#ffffff');
      p.interiorCeiling.emissiveIntensity = 0.06;
      p.interiorWall.emissive.set('#000000');
      p.interiorWall.emissiveIntensity = 0.0;
      p.interiorFloor.emissive.set('#000000');
      p.interiorFloor.emissiveIntensity = 0.0;
      p.glass.opacity = 0.38;
      p.glass.metalness = 0.56;
      p.glass.envMapIntensity = 3.8;
    }
  }

  dispose(): void {
    for (const p of this.palettes.values()) {
      for (const mat of Object.values(p)) {
        mat.dispose();
      }
    }
    this.palettes.clear();
    for (const tex of this.allLoadedTextures) {
      tex.dispose();
    }
    this.allLoadedTextures = [];
    this.leafSprigTex.map.dispose();
    this.leafSprigTex.normalMap.dispose();
    this.leafSprigTex.roughnessMap.dispose();
  }
}
