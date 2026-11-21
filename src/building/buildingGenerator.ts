import * as THREE from 'three/webgpu';
import {
  ArchitecturalStyle,
  EPS,
  FaceDir,
  GROUND_FLOOR_HEIGHT,
  MassingBox,
  MassingState,
  TYPICAL_FLOOR_HEIGHT,
} from '../core/types';
import {
  computeMergedExteriorPatches,
  getFloorElevationsUpTo,
  MergedExteriorPatch,
} from '../core/massingEngine';
import { MaterialGeometryBatcher } from './geometryUtils';
import { BotanicalFoliageBatcher } from './foliageGenerator';
import { BuildingMaterialPalette } from './materials';

export interface BuildingBuildOptions {
  style: ArchitecturalStyle;
  showColumns: boolean;
  showSite: boolean;
}

interface WallInterval {
  a: number;
  b: number;
}

function subtractIntervals1D(base: WallInterval, cutters: WallInterval[]): WallInterval[] {
  let current: WallInterval[] = [base];
  for (const cut of cutters) {
    const next: WallInterval[] = [];
    for (const seg of current) {
      if (cut.b <= seg.a + EPS || cut.a >= seg.b - EPS) {
        next.push(seg);
      } else {
        if (cut.a > seg.a + EPS) next.push({ a: seg.a, b: cut.a });
        if (cut.b < seg.b - EPS) next.push({ a: cut.b, b: seg.b });
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current.filter((s) => s.b - s.a > 0.08);
}

/**
 * Generates a complete, high-detail full-PBR architectural building with:
 * - Real connected hollow 3D empty interiors (floor slabs, plaster ceilings, structural
 *   columns, minimalist elevator/service cores, recessed linear ceiling lights)
 * - Untextured crystal-clear exterior-reflective plate glass (zero z-fighting)
 * - Z-fighting-free double-height entrance portal & cantilevered canopy
 * - Multi-branch botanical trees & terrace shrubs
 */
export function generatePBRBuilding(
  state: MassingState,
  palette: BuildingMaterialPalette,
  options: BuildingBuildOptions
): { group: THREE.Group; bounds: THREE.Box3 } {
  const batcher = new MaterialGeometryBatcher();
  const foliageBatcher = new BotanicalFoliageBatcher();
  const patches = computeMergedExteriorPatches(state);

  let minX = Infinity,
    maxX = -Infinity;
  let minZ = Infinity,
    maxZ = -Infinity;
  let maxY = 0;

  for (const b of state.boxes) {
    minX = Math.min(minX, b.min[0]);
    maxX = Math.max(maxX, b.max[0]);
    minZ = Math.min(minZ, b.min[2]);
    maxZ = Math.max(maxZ, b.max[2]);
    maxY = Math.max(maxY, b.max[1]);
  }
  if (!isFinite(minX)) {
    minX = -6;
    maxX = 6;
    minZ = -5;
    maxZ = 5;
    maxY = 7.8;
  }

  const floorElevations = getFloorElevationsUpTo(maxY + 0.5);

  const wallPatches: MergedExteriorPatch[] = [];
  const roofPatches: MergedExteriorPatch[] = [];
  const soffitPatches: MergedExteriorPatch[] = [];

  for (const p of patches) {
    if (p.dir === '+y') roofPatches.push(p);
    else if (p.dir === '-y' && p.plane > 0.2) soffitPatches.push(p);
    else if (p.dir !== '-y') wallPatches.push(p);
  }

  // 1. REAL HOLLOW 3D ARCHITECTURAL INTERIORS (connected floor slabs, plaster ceilings,
  //    structural columns, minimalist elevator core & linear recessed ceiling LEDs!)
  buildHollowInteriors(batcher, state.boxes, floorElevations);

  // Pick the primary ground-level facade for the grand architectural main entrance
  const entrancePatch = pickMainEntrancePatch(wallPatches);

  // 2. Build all exterior architectural facades with connected interior plaster backings
  for (const patch of wallPatches) {
    buildFacadePatch(batcher, patch, floorElevations, options.style, patch === entrancePatch);
  }

  // 3. Build crisp architectural corner piers at vertical exterior junctions
  buildCornerPiers(batcher, wallPatches);

  // 4. Build rooftops, parapets, walkable terraces, glass balustrades, penthouses & solar arrays
  for (const patch of roofPatches) {
    buildRoofOrTerrace(batcher, foliageBatcher, patch, state.boxes, maxY);
  }

  // 5. Build cantilevered soffits, recessed LED downlights, and optional structural pilotis
  for (const patch of soffitPatches) {
    buildCantileverSoffit(batcher, patch, state.boxes, options.showColumns);
  }

  // 6. Dynamic urban plaza, architectural benches, streetlamps & botanical trees
  if (options.showSite) {
    buildSiteContext(batcher, foliageBatcher, state.boxes, minX, maxX, minZ, maxZ);
  }

  // Assemble merged BufferGeometries into one clean Group
  const group = new THREE.Group();
  group.name = 'ProceduralPBRBuilding';

  const geometries = batcher.buildGeometries();
  const materialMap: Record<string, THREE.Material> = {
    facadePrimary: palette.facadePrimary,
    facadeSecondary: palette.facadeSecondary,
    plinth: palette.plinth,
    mullion: palette.mullion,
    accentMetal: palette.accentMetal,
    glass: palette.glass,
    spandrelGlass: palette.spandrelGlass,
    balustradeGlass: palette.balustradeGlass,
    interiorWall: palette.interiorWall,
    interiorCeiling: palette.interiorCeiling,
    interiorFloor: palette.interiorFloor,
    roofDeck: palette.roofDeck,
    terracePaver: palette.terracePaver,
    soffitWood: palette.soffitWood,
    concrete: palette.concrete,
    solarPanel: palette.solarPanel,
    emissiveWarm: palette.emissiveWarm,
    emissiveCool: palette.emissiveCool,
    bark: palette.bark,
    plazaPaver: palette.plazaPaver,
    asphalt: palette.asphalt,
  };

  for (const [key, geo] of geometries.entries()) {
    const mat = materialMap[key];
    if (!mat) {
      geo.dispose();
      continue;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `Building_${key}`;
    const isTransparent = key === 'glass' || key === 'balustradeGlass';
    const isGround = key === 'asphalt';
    mesh.castShadow = !isTransparent && !isGround;
    mesh.receiveShadow = !isTransparent;
    if (isTransparent) {
      mesh.renderOrder = 2;
    }
    group.add(mesh);
  }

  const { barkGeo, foliageGeo } = foliageBatcher.build();
  if (barkGeo) {
    const barkMesh = new THREE.Mesh(barkGeo, palette.bark);
    barkMesh.name = 'Botanical_Trunks';
    barkMesh.castShadow = true;
    barkMesh.receiveShadow = true;
    group.add(barkMesh);
  }
  if (foliageGeo) {
    const foliageMesh = new THREE.Mesh(foliageGeo, palette.foliage);
    foliageMesh.name = 'Botanical_Foliage';
    foliageMesh.castShadow = true;
    foliageMesh.receiveShadow = true;
    group.add(foliageMesh);
  }

  const bounds = new THREE.Box3(
    new THREE.Vector3(minX, 0, minZ),
    new THREE.Vector3(maxX, maxY + 2.5, maxZ)
  );

  return { group, bounds };
}

/**
 * Generates real connected hollow 3D architectural interiors inside every MassingBox:
 * - Seamless floor slabs & acoustic plaster ceilings joined cleanly to exterior spandrels
 *   and flush across internal seams between adjacent extruded blocks
 * - World-aligned structural concrete interior columns
 * - Clean minimalist interior elevator/service core on generous floorplates
 * - Recessed linear warm architectural ceiling light coves
 */
function buildHollowInteriors(
  batcher: MaterialGeometryBatcher,
  boxes: MassingBox[],
  floorElevations: number[]
): void {
  // Helper: check if point (x, y, z) is strictly deep inside the building volume (clearance from all exterior faces)
  const isDeepInside = (x: number, y: number, z: number, margin: number): boolean => {
    const pts: [number, number][] = [
      [x - margin, z - margin],
      [x + margin, z - margin],
      [x - margin, z + margin],
      [x + margin, z + margin],
    ];
    return pts.every(([px, pz]) =>
      boxes.some(
        (b) =>
          px >= b.min[0] &&
          px <= b.max[0] &&
          pz >= b.min[2] &&
          pz <= b.max[2] &&
          y >= b.min[1] - 0.05 &&
          y <= b.max[1] + 0.05
      )
    );
  };

  for (const b of boxes) {
    const cuts: number[] = [b.min[1]];
    for (const fy of floorElevations) {
      if (fy > b.min[1] + 0.35 && fy < b.max[1] - 0.35) {
        cuts.push(fy);
      }
    }
    cuts.push(b.max[1]);

    // Check which sides of this box touch another neighboring box (so slabs connect seamlessly flush!)
    const touchesNegX = boxes.some(
      (o) =>
        o.id !== b.id &&
        Math.abs(o.max[0] - b.min[0]) < EPS &&
        o.max[1] > b.min[1] + EPS &&
        o.min[1] < b.max[1] - EPS &&
        o.max[2] > b.min[2] + EPS &&
        o.min[2] < b.max[2] - EPS
    );
    const touchesPosX = boxes.some(
      (o) =>
        o.id !== b.id &&
        Math.abs(o.min[0] - b.max[0]) < EPS &&
        o.max[1] > b.min[1] + EPS &&
        o.min[1] < b.max[1] - EPS &&
        o.max[2] > b.min[2] + EPS &&
        o.min[2] < b.max[2] - EPS
    );
    const touchesNegZ = boxes.some(
      (o) =>
        o.id !== b.id &&
        Math.abs(o.max[2] - b.min[2]) < EPS &&
        o.max[1] > b.min[1] + EPS &&
        o.min[1] < b.max[1] - EPS &&
        o.max[0] > b.min[0] + EPS &&
        o.min[0] < b.max[0] - EPS
    );
    const touchesPosZ = boxes.some(
      (o) =>
        o.id !== b.id &&
        Math.abs(o.min[2] - b.max[2]) < EPS &&
        o.max[1] > b.min[1] + EPS &&
        o.min[1] < b.max[1] - EPS &&
        o.max[0] > b.min[0] + EPS &&
        o.min[0] < b.max[0] - EPS
    );

    // Tucked safely behind the exterior spandrel cladding (+0.04m) while overlapping
    // the inner plaster face (-0.25m) so floor/ceiling joints have ZERO cracks!
    const x0 = b.min[0] + (touchesNegX ? 0.0 : 0.08);
    const x1 = b.max[0] - (touchesPosX ? 0.0 : 0.08);
    const z0 = b.min[2] + (touchesNegZ ? 0.0 : 0.08);
    const z1 = b.max[2] - (touchesPosZ ? 0.0 : 0.08);
    if (x1 - x0 < 0.4 || z1 - z0 < 0.4) continue;

    for (let s = 0; s < cuts.length - 1; s++) {
      const y0 = cuts[s];
      const y1 = cuts[s + 1];
      const storyH = y1 - y0;
      if (storyH < 1.2) continue;

      const floorTop = y0 + (y0 < 0.05 ? 0.08 : 0.10);
      const ceilBot = y1 - 0.24;

      // Honed concrete/terrazzo interior floor finish slab
      batcher.addBox('interiorFloor', x0, y0, z0, x1, floorTop, z1, 3.2);

      // Matte architectural plaster ceiling slab
      if (ceilBot > floorTop + 0.5) {
        batcher.addBox('interiorCeiling', x0, ceilBot, z0, x1, y1 - 0.04, z1, 3.5);
      }

      // Recessed linear architectural warm LED ceiling light troughs
      const lx0 = b.min[0] + 1.35;
      const lx1 = b.max[0] - 1.35;
      const lz0 = b.min[2] + 1.35;
      const lz1 = b.max[2] - 1.35;
      if (lx1 - lx0 >= 1.4 && lz1 - lz0 >= 1.4 && ceilBot > floorTop + 1.5) {
        const spanX = lx1 - lx0;
        const spanZ = lz1 - lz0;
        if (spanX >= spanZ) {
          const rows = Math.max(1, Math.min(4, Math.floor(spanZ / 3.0)));
          for (let r = 0; r < rows; r++) {
            const cz = lz0 + ((r + 0.5) * spanZ) / rows;
            batcher.addBox(
              'emissiveWarm',
              lx0,
              ceilBot - 0.025,
              cz - 0.055,
              lx1,
              ceilBot + 0.005,
              cz + 0.055,
              1.0
            );
          }
        } else {
          const cols = Math.max(1, Math.min(4, Math.floor(spanX / 3.0)));
          for (let c = 0; c < cols; c++) {
            const cx = lx0 + ((c + 0.5) * spanX) / cols;
            batcher.addBox(
              'emissiveWarm',
              cx - 0.055,
              ceilBot - 0.025,
              lz0,
              cx + 0.055,
              ceilBot + 0.005,
              lz1,
              1.0
            );
          }
        }
      }

      // Clean minimalist central architectural elevator/service core inside generous floorplates
      const bw = b.max[0] - b.min[0];
      const bd = b.max[2] - b.min[2];
      const coreMidY = (floorTop + ceilBot) * 0.5;
      if (bw >= 8.0 && bd >= 7.0 && ceilBot > floorTop + 1.6) {
        const cx = (b.min[0] + b.max[0]) * 0.5;
        const cz = (b.min[2] + b.max[2]) * 0.5;
        const coreHalfW = Math.min(2.1, bw * 0.17);
        const coreHalfD = Math.min(1.8, bd * 0.17);
        if (isDeepInside(cx, coreMidY, cz, Math.max(coreHalfW, coreHalfD) + 1.8)) {
          batcher.addBox(
            'interiorWall',
            cx - coreHalfW,
            floorTop,
            cz - coreHalfD,
            cx + coreHalfW,
            ceilBot,
            cz + coreHalfD,
            3.0
          );
          // Subtle recessed architectural elevator portal trim on core face
          if (coreHalfW >= 1.1) {
            batcher.addBox(
              'mullion',
              cx - 0.58,
              floorTop,
              cz + coreHalfD - 0.01,
              cx + 0.58,
              Math.min(ceilBot - 0.25, floorTop + 2.3),
              cz + coreHalfD + 0.03,
              2.0
            );
          }
        }
      }

      // World-aligned interior structural concrete columns (clear of windows & central core)
      if (ceilBot > floorTop + 1.6) {
        const gridStep = 5.0;
        const startX = Math.ceil((b.min[0] + 1.8) / gridStep) * gridStep;
        const startZ = Math.ceil((b.min[2] + 1.8) / gridStep) * gridStep;
        const colHalf = 0.20;
        const cxBox = (b.min[0] + b.max[0]) * 0.5;
        const czBox = (b.min[2] + b.max[2]) * 0.5;

        for (let gx = startX; gx <= b.max[0] - 1.8; gx += gridStep) {
          for (let gz = startZ; gz <= b.max[2] - 1.8; gz += gridStep) {
            // Skip if inside central core zone
            if (Math.abs(gx - cxBox) < 2.5 && Math.abs(gz - czBox) < 2.2 && bw >= 8 && bd >= 7) {
              continue;
            }
            if (!isDeepInside(gx, coreMidY, gz, 1.55)) continue;
            batcher.addBox(
              'concrete',
              gx - colHalf,
              floorTop,
              gz - colHalf,
              gx + colHalf,
              ceilBot,
              gz + colHalf,
              2.6
            );
          }
        }
      }
    }
  }
}

function pickMainEntrancePatch(wallPatches: MergedExteriorPatch[]): MergedExteriorPatch | null {
  const groundWalls = wallPatches.filter(
    (p) => p.rect.v0 < 0.1 && p.rect.v1 >= 3.2 && p.rect.u1 - p.rect.u0 >= 4.0
  );
  if (groundWalls.length === 0) return null;

  groundWalls.sort((a, b) => {
    const prefA = a.dir === '+z' ? 100 : a.dir === '+x' ? 15 : 0;
    const prefB = b.dir === '+z' ? 100 : b.dir === '+x' ? 15 : 0;
    const scoreA = prefA + (a.rect.u1 - a.rect.u0) + a.plane * 0.2;
    const scoreB = prefB + (b.rect.u1 - b.rect.u0) + b.plane * 0.2;
    return scoreB - scoreA;
  });

  return groundWalls[0];
}

function addWallLocalBox(
  batcher: MaterialGeometryBatcher,
  dir: FaceDir,
  plane: number,
  mat: string,
  u0: number,
  y0: number,
  d0: number,
  u1: number,
  y1: number,
  d1: number,
  uvScale = 3.0
): void {
  switch (dir) {
    case '+z':
      batcher.addBox(mat, u0, y0, plane + d0, u1, y1, plane + d1, uvScale);
      break;
    case '-z':
      batcher.addBox(mat, u0, y0, plane - d1, u1, y1, plane - d0, uvScale);
      break;
    case '+x':
      batcher.addBox(mat, plane + d0, y0, u0, plane + d1, y1, u1, uvScale);
      break;
    case '-x':
      batcher.addBox(mat, plane - d1, y0, u0, plane - d0, y1, u1, uvScale);
      break;
  }
}

function addWallQuad(
  batcher: MaterialGeometryBatcher,
  dir: FaceDir,
  plane: number,
  mat: string,
  u0: number,
  y0: number,
  u1: number,
  y1: number,
  depth: number,
  uv0: [number, number] = [0, 0],
  uv1: [number, number] = [1, 1]
): void {
  if (u1 - u0 < 0.02 || y1 - y0 < 0.02) return;
  const [ua, va] = uv0;
  const [ub, vb] = uv1;
  const uvs: [[number, number], [number, number], [number, number], [number, number]] = [
    [ua, va],
    [ub, va],
    [ub, vb],
    [ua, vb],
  ];

  switch (dir) {
    case '+z': {
      const z = plane + depth;
      batcher.addQuad(mat, [u0, y0, z], [u1, y0, z], [u1, y1, z], [u0, y1, z], [0, 0, 1], uvs);
      break;
    }
    case '-z': {
      const z = plane - depth;
      batcher.addQuad(mat, [u1, y0, z], [u0, y0, z], [u0, y1, z], [u1, y1, z], [0, 0, -1], uvs);
      break;
    }
    case '+x': {
      const x = plane + depth;
      batcher.addQuad(mat, [x, y0, u1], [x, y0, u0], [x, y1, u0], [x, y1, u1], [1, 0, 0], uvs);
      break;
    }
    case '-x': {
      const x = plane - depth;
      batcher.addQuad(mat, [x, y0, u0], [x, y0, u1], [x, y1, u1], [x, y1, u0], [-1, 0, 0], uvs);
      break;
    }
  }
}

function buildFacadePatch(
  batcher: MaterialGeometryBatcher,
  patch: MergedExteriorPatch,
  floorElevations: number[],
  style: ArchitecturalStyle,
  hasEntrance: boolean
): void {
  const { dir, plane, rect } = patch;
  const wallW = rect.u1 - rect.u0;
  const wallH = rect.v1 - rect.v0;

  // Very narrow wall slivers stay crisp solid cladding with interior plaster lining
  if (wallW < 1.3 || wallH < 1.3) {
    addWallLocalBox(batcher, dir, plane, 'facadePrimary', rect.u0, rect.v0, -0.22, rect.u1, rect.v1, 0.03, 3.0);
    addWallLocalBox(batcher, dir, plane, 'interiorWall', rect.u0, rect.v0, -0.26, rect.u1, rect.v1, -0.22, 3.0);
    return;
  }

  const targetBay =
    style === 'brick-loft' ? 2.65 : style === 'travertine-bronze' ? 3.2 : 3.05;
  const numBays = Math.max(1, Math.round(wallW / targetBay));
  const bayW = wallW / numBays;
  const halfPier = Math.min(
    style === 'brick-loft' ? 0.34 : style === 'travertine-bronze' ? 0.30 : 0.22,
    bayW * 0.19
  );
  const uvScale = style === 'brick-loft' ? 2.0 : style === 'travertine-bronze' ? 2.8 : 3.2;

  const cuts: number[] = [rect.v0];
  for (const fy of floorElevations) {
    if (fy > rect.v0 + 0.35 && fy < rect.v1 - 0.35) {
      cuts.push(fy);
    }
  }
  cuts.push(rect.v1);

  const centerBayIdx = Math.floor(numBays / 2);

  // Pre-compute entrance door opening interval so ground plinth NEVER overlaps or z-fights with the door!
  let doorCutU0 = 0;
  let doorCutU1 = 0;
  let hasDoorCut = false;
  if (hasEntrance && rect.v0 < 0.08) {
    const bu0 = rect.u0 + centerBayIdx * bayW;
    const bu1 = bu0 + bayW;
    const lp = centerBayIdx === 0 ? halfPier * 1.3 : halfPier;
    const rp = centerBayIdx === numBays - 1 ? halfPier * 1.3 : halfPier;
    const wu0 = bu0 + lp;
    const wu1 = bu1 - rp;
    const midU = (wu0 + wu1) * 0.5;
    const doorW = Math.min(2.1, Math.max(1.2, wu1 - wu0 - 0.18));
    doorCutU0 = midU - doorW * 0.5 - 0.08;
    doorCutU1 = midU + doorW * 0.5 + 0.08;
    hasDoorCut = true;
  }

  // Ground dark honed concrete water-table plinth (cleanly carved around entrance doorway!)
  if (rect.v0 < 0.08) {
    if (hasDoorCut) {
      if (doorCutU0 > rect.u0 + 0.05) {
        addWallLocalBox(batcher, dir, plane, 'plinth', rect.u0, 0, -0.22, doorCutU0, 0.36, 0.055, 2.8);
        addWallLocalBox(batcher, dir, plane, 'interiorWall', rect.u0, 0.08, -0.26, doorCutU0, 0.36, -0.22, 3.0);
      }
      if (rect.u1 > doorCutU1 + 0.05) {
        addWallLocalBox(batcher, dir, plane, 'plinth', doorCutU1, 0, -0.22, rect.u1, 0.36, 0.055, 2.8);
        addWallLocalBox(batcher, dir, plane, 'interiorWall', doorCutU1, 0.08, -0.26, rect.u1, 0.36, -0.22, 3.0);
      }
    } else {
      addWallLocalBox(batcher, dir, plane, 'plinth', rect.u0, 0, -0.22, rect.u1, 0.36, 0.055, 2.8);
      addWallLocalBox(batcher, dir, plane, 'interiorWall', rect.u0, 0.08, -0.26, rect.u1, 0.36, -0.22, 3.0);
    }
  }

  for (let sIdx = 0; sIdx < cuts.length - 1; sIdx++) {
    const y0 = cuts[sIdx];
    const y1 = cuts[sIdx + 1];
    const storyH = y1 - y0;
    const isGround = y0 < 0.1;
    const isTopOfPatch = sIdx === cuts.length - 2;
    const floorNumber = Math.max(
      0,
      Math.round((y0 - (y0 > 0.1 ? GROUND_FLOOR_HEIGHT - TYPICAL_FLOOR_HEIGHT : 0)) / TYPICAL_FLOOR_HEIGHT)
    );

    if (storyH < 1.75) {
      addWallLocalBox(batcher, dir, plane, 'facadePrimary', rect.u0, y0, -0.22, rect.u1, y1, 0.03, uvScale);
      addWallLocalBox(batcher, dir, plane, 'interiorWall', rect.u0, y0, -0.26, rect.u1, y1, -0.22, 3.0);
      addWallLocalBox(batcher, dir, plane, 'accentMetal', rect.u0, y1 - 0.09, 0.03, rect.u1, y1, 0.08, 2.0);
      continue;
    }

    const bottomSpandrelH = isGround ? 0.36 : style === 'brick-loft' ? 0.62 : 0.32;
    const topSpandrelH = isGround ? 0.62 : style === 'contemporary' ? 0.44 : 0.52;
    const winY0 = y0 + bottomSpandrelH;
    const winY1 = y1 - topSpandrelH;

    // Lower spandrel band (upper floors) + clean interior plaster lining
    if (!isGround) {
      addWallLocalBox(batcher, dir, plane, 'facadePrimary', rect.u0, y0, -0.22, rect.u1, winY0, 0.04, uvScale);
      addWallLocalBox(batcher, dir, plane, 'interiorWall', rect.u0, y0 + 0.08, -0.26, rect.u1, winY0, -0.22, 3.0);
    }

    // Upper spandrel beam + dark reflective shadowbox band (contemporary) + interior plaster lining
    if (!isGround && style === 'contemporary') {
      // Sleek architectural slab edge + recessed dark mirror spandrel glass panel!
      addWallLocalBox(batcher, dir, plane, 'facadePrimary', rect.u0, y1 - 0.14, -0.22, rect.u1, y1, 0.05, uvScale);
      addWallLocalBox(batcher, dir, plane, 'spandrelGlass', rect.u0, winY1, -0.14, rect.u1, y1 - 0.14, -0.07, 2.0);
      addWallLocalBox(batcher, dir, plane, 'concrete', rect.u0, winY1, -0.22, rect.u1, y1 - 0.14, -0.14, 3.0);
      addWallLocalBox(batcher, dir, plane, 'interiorWall', rect.u0, winY1, -0.26, rect.u1, y1 - 0.22, -0.22, 3.0);
    } else {
      addWallLocalBox(
        batcher,
        dir,
        plane,
        isGround ? 'facadeSecondary' : 'facadePrimary',
        rect.u0,
        winY1,
        -0.22,
        rect.u1,
        y1,
        0.04,
        uvScale
      );
      addWallLocalBox(batcher, dir, plane, 'interiorWall', rect.u0, winY1, -0.26, rect.u1, y1 - 0.22, -0.22, 3.0);
    }

    // Crisp architectural drip-edge cornice & subtle recessed shadow reveal below it
    const corniceProj = isGround || isTopOfPatch ? 0.11 : 0.075;
    addWallLocalBox(
      batcher,
      dir,
      plane,
      'mullion',
      rect.u0,
      y1 - 0.13,
      0.04,
      rect.u1,
      y1 - 0.095,
      0.06,
      2.0
    );
    addWallLocalBox(
      batcher,
      dir,
      plane,
      isGround ? 'plinth' : 'facadeSecondary',
      rect.u0,
      y1 - 0.095,
      0.04,
      rect.u1,
      y1,
      corniceProj,
      2.5
    );

    // Iterate bays across this floor
    for (let b = 0; b < numBays; b++) {
      const bu0 = rect.u0 + b * bayW;
      const bu1 = bu0 + bayW;
      const isEntranceBay = isGround && hasEntrance && b === centerBayIdx;

      const leftPierW = b === 0 ? halfPier * 1.3 : halfPier;
      const rightPierW = b === numBays - 1 ? halfPier * 1.3 : halfPier;
      const pierMat = isGround ? 'plinth' : 'facadePrimary';
      const pierProj = isGround ? 0.065 : style === 'travertine-bronze' ? 0.085 : 0.055;

      // Left & right structural piers (strictly between winY0 and winY1 — zero overlap with spandrels!)
      addWallLocalBox(batcher, dir, plane, pierMat, bu0, winY0, -0.22, bu0 + leftPierW, winY1, pierProj, uvScale);
      addWallLocalBox(batcher, dir, plane, 'interiorWall', bu0, winY0, -0.26, bu0 + leftPierW, winY1, -0.22, 3.0);

      addWallLocalBox(batcher, dir, plane, pierMat, bu1 - rightPierW, winY0, -0.22, bu1, winY1, pierProj, uvScale);
      addWallLocalBox(batcher, dir, plane, 'interiorWall', bu1 - rightPierW, winY0, -0.26, bu1, winY1, -0.22, 3.0);

      const wu0 = bu0 + leftPierW;
      const wu1 = bu1 - rightPierW;
      const winW = wu1 - wu0;
      const winH = winY1 - winY0;
      if (winW < 0.45 || winH < 0.55) {
        addWallLocalBox(batcher, dir, plane, pierMat, wu0, winY0, -0.22, wu1, winY1, 0.03, uvScale);
        addWallLocalBox(batcher, dir, plane, 'interiorWall', wu0, winY0, -0.26, wu1, winY1, -0.22, 3.0);
        continue;
      }

      const frameT = 0.06;
      const frameD0 = -0.22;
      const frameD1 = -0.09;

      if (isEntranceBay) {
        // Grand Z-Fighting-Free Double-Height Glass Entrance Portal + Cantilevered Canopy!
        buildEntrancePortal(batcher, dir, plane, wu0, wu1, winY0, winY1, y1);
        continue;
      }

      // Perimeter recessed dark anodized window frame (head, sill, jambs — non-overlapping!)
      addWallLocalBox(batcher, dir, plane, 'mullion', wu0, winY0, frameD0, wu1, winY0 + frameT, frameD1, 2.0);
      addWallLocalBox(batcher, dir, plane, 'mullion', wu0, winY1 - frameT, frameD0, wu1, winY1, frameD1, 2.0);
      addWallLocalBox(batcher, dir, plane, 'mullion', wu0, winY0 + frameT, frameD0, wu0 + frameT, winY1 - frameT, frameD1, 2.0);
      addWallLocalBox(batcher, dir, plane, 'mullion', wu1 - frameT, winY0 + frameT, frameD0, wu1, winY1 - frameT, frameD1, 2.0);

      // Sloped architectural window sill projecting cleanly from the lower spandrel
      if (!isGround) {
        addWallLocalBox(
          batcher,
          dir,
          plane,
          style === 'brick-loft' ? 'facadeSecondary' : 'accentMetal',
          wu0 - 0.02,
          winY0 - 0.055,
          -0.09,
          wu1 + 0.02,
          winY0,
          0.085,
          2.0
        );
      }

      // Clear untextured exterior-reflective glass pane strictly inside the perimeter frame
      const gx0 = wu0 + frameT + 0.002;
      const gx1 = wu1 - frameT - 0.002;
      const gy0 = winY0 + frameT + 0.002;
      const gy1 = winY1 - frameT - 0.002;
      const glassDepth = -0.145;

      addWallQuad(batcher, dir, plane, 'glass', gx0, gy0, gx1, gy1, glassDepth);

      if (isGround) {
        // Ground-floor storefront transom & vertical mullion caps proud in front of glass (zero z-fighting!)
        const transomY = winY0 + Math.min(winH * 0.68, 2.45);
        addWallLocalBox(batcher, dir, plane, 'mullion', gx0, transomY - 0.028, -0.14, gx1, transomY + 0.028, -0.06, 2.0);
        if (winW > 1.7) {
          const midU = (wu0 + wu1) * 0.5;
          addWallLocalBox(batcher, dir, plane, 'mullion', midU - 0.024, gy0, -0.14, midU + 0.024, gy1, -0.06, 2.0);
        }
      } else {
        // Style-specific upper-floor exterior mullion caps, louvers, fins & Juliet balconies
        if (style === 'contemporary') {
          if (winW > 1.45) {
            const midU = (wu0 + wu1) * 0.5;
            addWallLocalBox(batcher, dir, plane, 'mullion', midU - 0.022, gy0, -0.14, midU + 0.022, gy1, -0.055, 2.0);
          }
          // Sleek champagne-bronze brise-soleil sunshade eyebrow blade
          addWallLocalBox(
            batcher,
            dir,
            plane,
            'accentMetal',
            wu0 - 0.02,
            winY1 - 0.035,
            -0.02,
            wu1 + 0.02,
            winY1 + 0.025,
            0.26,
            2.0
          );
        } else if (style === 'brick-loft') {
          const vPanes = winW > 1.6 ? 3 : 2;
          for (let k = 1; k < vPanes; k++) {
            const mu = wu0 + (winW * k) / vPanes;
            addWallLocalBox(batcher, dir, plane, 'mullion', mu - 0.018, gy0, -0.14, mu + 0.018, gy1, -0.085, 2.0);
          }
          const transomY = winY0 + winH * 0.52;
          addWallLocalBox(batcher, dir, plane, 'mullion', gx0, transomY - 0.018, -0.14, gx1, transomY + 0.018, -0.085, 2.0);
          // Limestone lintel proud above window head
          addWallLocalBox(
            batcher,
            dir,
            plane,
            'facadeSecondary',
            wu0 - 0.06,
            winY1,
            0.04,
            wu1 + 0.06,
            winY1 + 0.16,
            0.085,
            2.0
          );
          // Slim black iron Juliet balcony railing on alternating bays
          if ((b + floorNumber) % 2 === 0 && winH > 1.5) {
            const railTop = winY0 + 0.92;
            addWallLocalBox(batcher, dir, plane, 'mullion', wu0, railTop - 0.035, 0.06, wu1, railTop, 0.11, 2.0);
            addWallLocalBox(batcher, dir, plane, 'mullion', wu0, winY0 + 0.03, 0.06, wu1, winY0 + 0.07, 0.11, 2.0);
            const pickets = Math.max(3, Math.floor(winW / 0.24));
            for (let p = 0; p <= pickets; p++) {
              const pu = wu0 + (winW * p) / pickets;
              addWallLocalBox(batcher, dir, plane, 'mullion', pu - 0.01, winY0 + 0.07, 0.072, pu + 0.01, railTop - 0.035, 0.098, 2.0);
            }
          }
        } else {
          // travertine-bronze: deep vertical bronze architectural fins + proud central bronze mullion
          const midU = (wu0 + wu1) * 0.5;
          addWallLocalBox(batcher, dir, plane, 'mullion', midU - 0.025, gy0, -0.14, midU + 0.025, gy1, -0.055, 2.0);
          addWallLocalBox(batcher, dir, plane, 'accentMetal', wu0, winY0, 0.04, wu0 + 0.045, winY1, 0.24, 2.0);
          addWallLocalBox(batcher, dir, plane, 'accentMetal', wu1 - 0.045, winY0, 0.04, wu1, winY1, 0.24, 2.0);
        }
      }
    }
  }
}

/**
 * Z-Fighting-Free Grand Architectural Main Entrance Portal:
 * Every frame bar, glass leaf, threshold step, pull handle, and canopy member occupies
 * strictly disjoint 3D space opening cleanly into the real hollow 3D ground lobby!
 */
function buildEntrancePortal(
  batcher: MaterialGeometryBatcher,
  dir: FaceDir,
  plane: number,
  wu0: number,
  wu1: number,
  winY0: number,
  winY1: number,
  storyTopY: number
): void {
  const midU = (wu0 + wu1) * 0.5;
  const doorH = Math.min(2.65, winY1 - 0.42);
  const doorW = Math.min(2.1, Math.max(1.2, wu1 - wu0 - 0.18));
  const du0 = midU - doorW * 0.5;
  const du1 = midU + doorW * 0.5;
  const jambT = 0.075;
  const headT = 0.075;

  // 1. Outer bronze architectural portal frame (strictly disjoint jambs & header)
  addWallLocalBox(batcher, dir, plane, 'accentMetal', du0 - jambT, 0.0, -0.22, du0, doorH, 0.045, 2.0);
  addWallLocalBox(batcher, dir, plane, 'accentMetal', du1, 0.0, -0.22, du1 + jambT, doorH, 0.045, 2.0);
  addWallLocalBox(
    batcher,
    dir,
    plane,
    'accentMetal',
    du0 - jambT,
    doorH,
    -0.22,
    du1 + jambT,
    doorH + headT,
    0.045,
    2.0
  );

  // 2. Perimeter upper bay frame above door transom
  const frameT = 0.055;
  addWallLocalBox(batcher, dir, plane, 'mullion', wu0, winY1 - frameT, -0.22, wu1, winY1, -0.09, 2.0);
  addWallLocalBox(batcher, dir, plane, 'mullion', wu0, winY0, -0.22, wu0 + frameT, winY1 - frameT, -0.09, 2.0);
  addWallLocalBox(batcher, dir, plane, 'mullion', wu1 - frameT, winY0, -0.22, wu1, winY1 - frameT, -0.09, 2.0);

  // 3. Double glass door leaves: bottom kickplates, top rails, center stile & SEPARATE glass panes
  const kickH = 0.16;
  const topRailH = 0.07;
  const stileHalf = 0.022;
  // Left & right leaf bottom kickplates + top rails
  addWallLocalBox(batcher, dir, plane, 'mullion', du0 + 0.006, 0.02, -0.155, midU - stileHalf, kickH, -0.105, 2.0);
  addWallLocalBox(batcher, dir, plane, 'mullion', midU + stileHalf, 0.02, -0.155, du1 - 0.006, kickH, -0.105, 2.0);
  addWallLocalBox(batcher, dir, plane, 'mullion', du0 + 0.006, doorH - topRailH, -0.155, midU - stileHalf, doorH - 0.004, -0.105, 2.0);
  addWallLocalBox(batcher, dir, plane, 'mullion', midU + stileHalf, doorH - topRailH, -0.155, du1 - 0.006, doorH - 0.004, -0.105, 2.0);
  // Center vertical meeting stile
  addWallLocalBox(batcher, dir, plane, 'mullion', midU - stileHalf, 0.02, -0.155, midU + stileHalf, doorH - 0.004, -0.105, 2.0);

  // Clean separate exterior-reflective door leaf glass panes (ZERO overlap with stiles/plinth!)
  const glassD = -0.13;
  addWallQuad(batcher, dir, plane, 'glass', du0 + 0.008, kickH + 0.002, midU - stileHalf - 0.002, doorH - topRailH - 0.002, glassD);
  addWallQuad(batcher, dir, plane, 'glass', midU + stileHalf + 0.002, kickH + 0.002, du1 - 0.008, doorH - topRailH - 0.002, glassD);

  // Upper transom glass pane above doorway
  addWallQuad(batcher, dir, plane, 'glass', wu0 + frameT + 0.002, doorH + headT + 0.002, wu1 - frameT - 0.002, winY1 - frameT - 0.002, glassD);

  // Sidelight glass panes if bay is wider than doorway
  if (du0 - jambT > wu0 + frameT + 0.08) {
    addWallQuad(batcher, dir, plane, 'glass', wu0 + frameT + 0.002, winY0 + 0.002, du0 - jambT - 0.002, doorH, glassD);
  }
  if (wu1 - frameT > du1 + jambT + 0.08) {
    addWallQuad(batcher, dir, plane, 'glass', du1 + jambT + 0.002, winY0 + 0.002, wu1 - frameT - 0.002, doorH, glassD);
  }

  // Brushed-bronze vertical architectural pull handles strictly proud of door glass
  addWallLocalBox(batcher, dir, plane, 'accentMetal', midU - 0.13, 0.90, -0.095, midU - 0.095, 1.58, -0.04, 2.0);
  addWallLocalBox(batcher, dir, plane, 'accentMetal', midU + 0.095, 0.90, -0.095, midU + 0.13, 1.58, -0.04, 2.0);

  // 4. Cantilevered steel-and-cedar entrance canopy (cleanly separated from spandrel)
  const canopyY = Math.min(storyTopY - 0.42, Math.max(doorH + 0.35, 3.12));
  const canopyU0 = wu0 - 0.42;
  const canopyU1 = wu1 + 0.42;
  const canopyProj = 2.15;

  addWallLocalBox(batcher, dir, plane, 'mullion', canopyU0, canopyY, 0.055, canopyU1, canopyY + 0.15, 0.18, 2.0);
  addWallLocalBox(batcher, dir, plane, 'mullion', canopyU0, canopyY, canopyProj - 0.14, canopyU1, canopyY + 0.15, canopyProj, 2.0);
  addWallLocalBox(batcher, dir, plane, 'mullion', canopyU0, canopyY, 0.18, canopyU0 + 0.14, canopyY + 0.15, canopyProj - 0.14, 2.0);
  addWallLocalBox(batcher, dir, plane, 'mullion', canopyU1 - 0.14, canopyY, 0.18, canopyU1, canopyY + 0.15, canopyProj - 0.14, 2.0);

  // Warm recessed cedar soffit + metallic fascia cap
  addWallLocalBox(batcher, dir, plane, 'soffitWood', canopyU0 + 0.14, canopyY + 0.02, 0.18, canopyU1 - 0.14, canopyY + 0.12, canopyProj - 0.14, 2.0);
  addWallLocalBox(batcher, dir, plane, 'accentMetal', canopyU0 - 0.01, canopyY + 0.15, 0.055, canopyU1 + 0.01, canopyY + 0.19, canopyProj + 0.03, 2.0);

  // Warm recessed LED canopy downlights
  const lights = 3;
  for (let i = 0; i < lights; i++) {
    const lu = canopyU0 + 0.55 + ((canopyU1 - canopyU0 - 1.1) * i) / (lights - 1);
    addWallLocalBox(
      batcher,
      dir,
      plane,
      'emissiveWarm',
      lu - 0.075,
      canopyY - 0.005,
      canopyProj * 0.48,
      lu + 0.075,
      canopyY + 0.02,
      canopyProj * 0.48 + 0.15,
      1.0
    );
  }

  // 5. Honed granite threshold entrance step strictly OUTSIDE the wall plinth (depth >= 0.065 -> ZERO z-fighting!)
  addWallLocalBox(
    batcher,
    dir,
    plane,
    'plinth',
    du0 - 0.42,
    0.0,
    0.065,
    du1 + 0.42,
    0.11,
    1.32,
    2.4
  );
}

/**
 * Places crisp vertical architectural corner quoins at exterior junctions (strictly proud of cladding -> zero z-fighting).
 */
function buildCornerPiers(batcher: MaterialGeometryBatcher, wallPatches: MergedExteriorPatch[]): void {
  const xWalls = wallPatches.filter((p) => p.dir === '+x' || p.dir === '-x');
  const zWalls = wallPatches.filter((p) => p.dir === '+z' || p.dir === '-z');
  const seen = new Set<string>();

  for (const xw of xWalls) {
    const cx = xw.plane;
    for (const zw of zWalls) {
      const cz = zw.plane;
      const xTouchesZ =
        Math.abs(xw.rect.u0 - cz) < 0.08 || Math.abs(xw.rect.u1 - cz) < 0.08;
      const zTouchesX =
        Math.abs(zw.rect.u0 - cx) < 0.08 || Math.abs(zw.rect.u1 - cx) < 0.08;
      if (!xTouchesZ || !zTouchesX) continue;

      const y0 = Math.max(xw.rect.v0, zw.rect.v0);
      const y1 = Math.min(xw.rect.v1, zw.rect.v1);
      if (y1 - y0 < 0.25) continue;

      const key = `${cx.toFixed(2)}|${cz.toFixed(2)}|${y0.toFixed(2)}|${y1.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const r = 0.098;
      batcher.addBox('facadePrimary', cx - r, y0, cz - r, cx + r, y1, cz + r, 3.0);
    }
  }
}

function buildRoofOrTerrace(
  batcher: MaterialGeometryBatcher,
  foliageBatcher: BotanicalFoliageBatcher,
  patch: MergedExteriorPatch,
  boxes: MassingBox[],
  maxBuildingY: number
): void {
  const y = patch.plane;
  const { u0: x0, u1: x1, v0: z0, v1: z1 } = patch.rect;
  const w = x1 - x0;
  const d = z1 - z0;

  const risingBoxes = boxes.filter((b) => b.max[1] > y + 0.15 && b.min[1] <= y + 0.15);

  const openNorth: WallInterval[] = subtractIntervals1D(
    { a: x0, b: x1 },
    risingBoxes
      .filter((b) => Math.abs(b.max[2] - z0) < 0.08)
      .map((b) => ({ a: b.min[0], b: b.max[0] }))
  );
  const openSouth: WallInterval[] = subtractIntervals1D(
    { a: x0, b: x1 },
    risingBoxes
      .filter((b) => Math.abs(b.min[2] - z1) < 0.08)
      .map((b) => ({ a: b.min[0], b: b.max[0] }))
  );
  const openWest: WallInterval[] = subtractIntervals1D(
    { a: z0, b: z1 },
    risingBoxes
      .filter((b) => Math.abs(b.max[0] - x0) < 0.08)
      .map((b) => ({ a: b.min[2], b: b.max[2] }))
  );
  const openEast: WallInterval[] = subtractIntervals1D(
    { a: z0, b: z1 },
    risingBoxes
      .filter((b) => Math.abs(b.min[0] - x1) < 0.08)
      .map((b) => ({ a: b.min[2], b: b.max[2] }))
  );

  const totalPerim = 2 * (w + d);
  const openPerim =
    openNorth.reduce((s, i) => s + (i.b - i.a), 0) +
    openSouth.reduce((s, i) => s + (i.b - i.a), 0) +
    openWest.reduce((s, i) => s + (i.b - i.a), 0) +
    openEast.reduce((s, i) => s + (i.b - i.a), 0);

  const abutsTallerWall = openPerim < totalPerim - 0.2;
  const isTerrace = abutsTallerWall || y < maxBuildingY - 0.5;

  // Watertight roof deck slab cleanly sitting atop the interior ceiling slab
  batcher.addBox(isTerrace ? 'terracePaver' : 'roofDeck', x0, y - 0.04, z0, x1, y + 0.08, z1, 2.6);

  const addEdge = (
    axis: 'x' | 'z',
    seg: WallInterval,
    fixedCoord: number,
    inwardSign: 1 | -1
  ) => {
    const len = seg.b - seg.a;
    if (len < 0.15) return;

    const placeBar = (mat: string, thick: number, h0: number, h1: number, projOut = 0) => {
      const cA = fixedCoord - inwardSign * projOut;
      const cB = fixedCoord + inwardSign * thick;
      if (axis === 'x') {
        batcher.addBox(mat, seg.a, y + h0, Math.min(cA, cB), seg.b, y + h1, Math.max(cA, cB), 2.5);
      } else {
        batcher.addBox(mat, Math.min(cA, cB), y + h0, seg.a, Math.max(cA, cB), y + h1, seg.b, 2.5);
      }
    };

    if (isTerrace) {
      placeBar('facadeSecondary', 0.24, 0.08, 0.34, 0.03);
      placeBar('accentMetal', 0.28, 0.34, 0.38, 0.05);
      const glassC = fixedCoord + inwardSign * 0.12;
      if (axis === 'x') {
        batcher.addBox('balustradeGlass', seg.a + 0.04, y + 0.38, glassC - 0.012, seg.b - 0.04, y + 1.14, glassC + 0.012, 1.0);
        batcher.addBox('accentMetal', seg.a, y + 1.14, glassC - 0.03, seg.b, y + 1.19, glassC + 0.03, 2.0);
      } else {
        batcher.addBox('balustradeGlass', glassC - 0.012, y + 0.38, seg.a + 0.04, glassC + 0.012, y + 1.14, seg.b - 0.04, 1.0);
        batcher.addBox('accentMetal', glassC - 0.03, y + 1.14, seg.a, glassC + 0.03, y + 1.19, seg.b, 2.0);
      }
      const posts = Math.max(2, Math.ceil(len / 2.2) + 1);
      for (let i = 0; i < posts; i++) {
        const p = seg.a + (len * i) / (posts - 1);
        if (axis === 'x') {
          batcher.addBox('mullion', p - 0.022, y + 0.38, glassC - 0.026, p + 0.022, y + 1.14, glassC + 0.026, 1.0);
        } else {
          batcher.addBox('mullion', glassC - 0.026, y + 0.38, p - 0.022, glassC + 0.026, y + 1.14, p + 0.022, 1.0);
        }
      }
    } else {
      placeBar('facadePrimary', 0.34, 0.08, 0.94, 0.04);
      placeBar('accentMetal', 0.42, 0.94, 1.03, 0.08);
    }
  };

  for (const s of openNorth) addEdge('x', s, z0, 1);
  for (const s of openSouth) addEdge('x', s, z1, -1);
  for (const s of openWest) addEdge('z', s, x0, 1);
  for (const s of openEast) addEdge('z', s, x1, -1);

  const safeX0 = x0 + 0.9;
  const safeX1 = x1 - 0.9;
  const safeZ0 = z0 + 0.9;
  const safeZ1 = z1 - 0.9;
  const safeW = safeX1 - safeX0;
  const safeD = safeZ1 - safeZ0;

  if (safeW < 1.2 || safeD < 1.2) return;

  if (isTerrace) {
    const planterSpots: [number, number][] = [];
    if (safeW >= 2.2 && safeD >= 1.6) {
      const cols = Math.min(4, Math.max(1, Math.floor(safeW / 3.4)));
      for (let i = 0; i < cols; i++) {
        const px = safeX0 + (safeW * (i + 0.5)) / cols;
        const pz = (safeZ0 + safeZ1) * 0.5;
        planterSpots.push([px, pz]);
      }
    }
    for (let idx = 0; idx < planterSpots.length; idx++) {
      const [px, pz] = planterSpots[idx];
      const pw = Math.min(1.4, safeW * 0.35);
      const pd = Math.min(0.9, safeD * 0.55);
      batcher.addBox('concrete', px - pw * 0.5, y + 0.08, pz - pd * 0.5, px + pw * 0.5, y + 0.56, pz + pd * 0.5, 2.0);
      batcher.addBox('bark', px - pw * 0.42, y + 0.52, pz - pd * 0.42, px + pw * 0.42, y + 0.58, pz + pd * 0.42, 1.0);
      foliageBatcher.addPlanterShrub(
        px,
        y + 0.56,
        pz,
        pw * 0.85,
        pd * 0.85,
        500 + idx * 37 + Math.round(px * 11 + pz * 17)
      );
    }
  } else {
    if (safeW >= 3.6 && safeD >= 3.6) {
      const phW = Math.min(4.6, safeW * 0.42);
      const phD = Math.min(3.8, safeD * 0.42);
      const phH = 2.35;
      const phX0 = safeX0 + 0.3;
      const phZ0 = safeZ0 + 0.3;
      const phX1 = phX0 + phW;
      const phZ1 = phZ0 + phD;

      batcher.addBox('concrete', phX0, y + 0.08, phZ0, phX1, y + phH, phZ1, 3.0);
      batcher.addBox('accentMetal', phX0 - 0.08, y + phH, phZ0 - 0.08, phX1 + 0.08, y + phH + 0.12, phZ1 + 0.08, 2.0);

      const slats = 5;
      for (let i = 0; i < slats; i++) {
        const sy = y + 0.55 + i * 0.32;
        batcher.addBox('mullion', phX0 + 0.35, sy, phZ1, phX1 - 0.35, sy + 0.10, phZ1 + 0.08, 1.0);
      }

      if (safeW - phW >= 2.2) {
        const hx0 = phX1 + 0.6;
        const hx1 = Math.min(safeX1 - 0.2, hx0 + 1.65);
        const hz0 = phZ0 + 0.2;
        const hz1 = hz0 + Math.min(1.4, phD * 0.7);
        if (hx1 - hx0 >= 0.9 && hz1 - hz0 >= 0.8) {
          batcher.addBox('facadeSecondary', hx0, y + 0.08, hz0, hx1, y + 1.05, hz1, 2.0);
          batcher.addCylinder('mullion', (hx0 + hx1) * 0.5, y + 1.05, y + 1.18, (hz0 + hz1) * 0.5, 0.34, 0.34, 14);
        }
      }

      if (safeD - phD >= 2.2) {
        const sx0 = safeX0 + safeW * 0.45;
        const sx1 = Math.min(safeX1 - 0.3, sx0 + Math.min(3.6, safeW * 0.48));
        const sz0 = phZ1 + 0.7;
        const sz1 = Math.min(safeZ1 - 0.3, sz0 + Math.min(2.4, safeD - phD - 1.0));
        if (sx1 - sx0 >= 1.5 && sz1 - sz0 >= 1.2) {
          batcher.addBox('mullion', sx0, y + 0.08, sz0, sx1, y + 0.42, sz1, 2.0);
          batcher.addBox('interiorCeiling', sx0 + 0.12, y + 0.14, sz0 + 0.12, sx1 - 0.12, y + 0.38, sz1 - 0.12, 2.0);
          batcher.addBox('glass', sx0 + 0.08, y + 0.42, sz0 + 0.08, sx1 - 0.08, y + 0.47, sz1 - 0.08, 1.0);
          const midX = (sx0 + sx1) * 0.5;
          batcher.addBox('mullion', midX - 0.03, y + 0.42, sz0, midX + 0.03, y + 0.50, sz1, 1.0);
        }
      }

      if (safeW >= 7.5 && safeD >= 5.5) {
        const arrayX0 = phX1 + 0.8;
        const arrayX1 = safeX1 - 0.4;
        const arrayZ0 = safeZ0 + 0.4;
        const arrayZ1 = Math.min(safeZ1 - 0.4, phZ1);
        const cols = Math.floor((arrayX1 - arrayX0) / 1.55);
        const rows = Math.floor((arrayZ1 - arrayZ0) / 1.35);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const px = arrayX0 + c * 1.55 + 0.7;
            const pz = arrayZ0 + r * 1.35 + 0.6;
            batcher.addBox('mullion', px - 0.5, y + 0.08, pz - 0.32, px - 0.44, y + 0.46, pz - 0.26, 1.0);
            batcher.addBox('mullion', px + 0.44, y + 0.08, pz - 0.32, px + 0.5, y + 0.46, pz - 0.26, 1.0);
            batcher.addBox('mullion', px - 0.5, y + 0.08, pz + 0.26, px - 0.44, y + 0.24, pz + 0.32, 1.0);
            batcher.addBox('mullion', px + 0.44, y + 0.08, pz + 0.26, px + 0.5, y + 0.24, pz + 0.32, 1.0);
            batcher.addBox('solarPanel', px - 0.64, y + 0.32, pz - 0.42, px + 0.64, y + 0.38, pz + 0.42, 1.0);
          }
        }
      }
    }
  }
}

function buildCantileverSoffit(
  batcher: MaterialGeometryBatcher,
  patch: MergedExteriorPatch,
  boxes: MassingBox[],
  showColumns: boolean
): void {
  const y = patch.plane;
  const { u0: x0, u1: x1, v0: z0, v1: z1 } = patch.rect;
  const w = x1 - x0;
  const d = z1 - z0;

  batcher.addBox('mullion', x0, y - 0.05, z0, x1, y + 0.08, z1, 2.5);
  const inset = Math.min(0.24, w * 0.15, d * 0.15);
  batcher.addBox('soffitWood', x0 + inset, y - 0.075, z0 + inset, x1 - inset, y - 0.02, z1 - inset, 2.2);

  const cols = Math.max(1, Math.floor((w - inset * 2) / 2.8));
  const rows = Math.max(1, Math.floor((d - inset * 2) / 2.8));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const lx = x0 + inset + ((w - inset * 2) * (i + 0.5)) / cols;
      const lz = z0 + inset + ((d - inset * 2) * (j + 0.5)) / rows;
      batcher.addBox('emissiveWarm', lx - 0.085, y - 0.09, lz - 0.085, lx + 0.085, y - 0.065, lz + 0.085, 1.0);
    }
  }

  // Only place structural pilotis under substantial elevated cantilevers (y >= 2.2m — never stubby piles!)
  if (showColumns && y >= 2.2 && Math.max(w, d) >= 3.2 && Math.min(w, d) >= 2.0) {
    const margin = Math.min(0.85, Math.min(w, d) * 0.25);
    const colPositions: [number, number][] = [
      [x0 + margin, z0 + margin],
      [x1 - margin, z0 + margin],
      [x0 + margin, z1 - margin],
      [x1 - margin, z1 - margin],
    ];

    for (const [cx, cz] of colPositions) {
      const nearWallBelow = boxes.some(
        (b) =>
          b.max[1] >= y - 0.1 &&
          b.min[1] < y - 0.2 &&
          cx >= b.min[0] - 1.1 &&
          cx <= b.max[0] + 1.1 &&
          cz >= b.min[2] - 1.1 &&
          cz <= b.max[2] + 1.1
      );
      if (nearWallBelow) continue;

      let baseY = 0;
      for (const b of boxes) {
        if (
          b.max[1] <= y - 0.2 &&
          cx >= b.min[0] &&
          cx <= b.max[0] &&
          cz >= b.min[2] &&
          cz <= b.max[2]
        ) {
          baseY = Math.max(baseY, b.max[1]);
        }
      }
      if (y - baseY < 1.8) continue;

      batcher.addCylinder('concrete', cx, baseY, y - 0.05, cz, 0.23, 0.23, 18);
      batcher.addCylinder('mullion', cx, baseY, baseY + 0.14, cz, 0.29, 0.27, 18);
      batcher.addCylinder('mullion', cx, y - 0.20, y - 0.05, cz, 0.27, 0.31, 18);
    }
  }
}

function buildSiteContext(
  batcher: MaterialGeometryBatcher,
  foliageBatcher: BotanicalFoliageBatcher,
  boxes: MassingBox[],
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number
): void {
  const pad = 9.8;
  const px0 = minX - pad;
  const px1 = maxX + pad;
  const pz0 = minZ - pad;
  const pz1 = maxZ + pad;

  // Raised architectural granite plaza deck & stepped perimeter curb
  batcher.addBox('plazaPaver', px0, -0.18, pz0, px1, 0.0, pz1, 3.6);
  batcher.addBox('concrete', px0 - 0.55, -0.26, pz0 - 0.55, px1 + 0.55, -0.10, pz1 + 0.55, 3.0);

  // Broad dark urban asphalt surround
  batcher.addBox('asphalt', px0 - 95, -0.34, pz0 - 95, px1 + 95, -0.26, pz1 + 95, 6.5);

  // Clean perimeter concrete sidewalks
  const roadGap = 3.5;
  batcher.addBox('concrete', px0 - roadGap, -0.28, pz0 - roadGap, px1 + roadGap, -0.22, pz0 - 0.65, 4.0);
  batcher.addBox('concrete', px0 - roadGap, -0.28, pz1 + 0.65, px1 + roadGap, -0.22, pz1 + roadGap, 4.0);
  batcher.addBox('concrete', px0 - roadGap, -0.28, pz0 - 0.65, px0 - 0.65, -0.22, pz1 + 0.65, 4.0);
  batcher.addBox('concrete', px1 + 0.65, -0.28, pz0 - 0.65, px1 + roadGap, -0.22, pz1 + 0.65, 4.0);

  const isClearOfBuilding = (x: number, z: number, radius: number) =>
    !boxes.some(
      (b) =>
        x >= b.min[0] - radius &&
        x <= b.max[0] + radius &&
        z >= b.min[2] - radius &&
        z <= b.max[2] + radius
    );

  // High-detail botanical multi-branch trees in concrete planter beds
  const treeCandidates: [number, number][] = [
    [px0 + 2.6, pz0 + 2.6],
    [px1 - 2.6, pz0 + 2.6],
    [px0 + 2.6, pz1 - 2.6],
    [px1 - 2.6, pz1 - 2.6],
    [(px0 + px1) * 0.5 - 6.2, pz1 - 2.5],
    [(px0 + px1) * 0.5 + 6.2, pz1 - 2.5],
    [px0 + 2.5, (pz0 + pz1) * 0.5],
    [px1 - 2.5, (pz0 + pz1) * 0.5],
  ];

  treeCandidates.forEach(([tx, tz], idx) => {
    if (!isClearOfBuilding(tx, tz, 3.6)) return;
    const hScale = 0.92 + (idx % 3) * 0.14;
    batcher.addBox('concrete', tx - 1.05, 0.0, tz - 1.05, tx + 1.05, 0.36, tz + 1.05, 2.2);
    batcher.addBox('bark', tx - 0.86, 0.32, tz - 0.86, tx + 0.86, 0.38, tz + 0.86, 1.0);
    foliageBatcher.addArchitecturalTree(tx, 0.34, tz, hScale, 1301 + idx * 97);
  });

  // Architectural concrete & cedar-slat plaza benches (adds real human architectural scale!)
  const benchCandidates: [number, number][] = [
    [(px0 + px1) * 0.5 - 3.6, pz1 - 2.8],
    [(px0 + px1) * 0.5 + 3.6, pz1 - 2.8],
  ];
  for (const [bx, bz] of benchCandidates) {
    if (!isClearOfBuilding(bx, bz, 2.4)) continue;
    batcher.addBox('concrete', bx - 0.95, 0.0, bz - 0.28, bx - 0.72, 0.42, bz + 0.28, 2.0);
    batcher.addBox('concrete', bx + 0.72, 0.0, bz - 0.28, bx + 0.95, 0.42, bz + 0.28, 2.0);
    batcher.addBox('soffitWood', bx - 1.02, 0.42, bz - 0.30, bx + 1.02, 0.49, bz + 0.30, 1.8);
  }

  // Sleek modern plaza bollard lights
  const bollardPoints: [number, number][] = [];
  const step = 6.5;
  for (let x = px0 + 4.5; x <= px1 - 4.5; x += step) {
    bollardPoints.push([x, pz1 - 0.85]);
    bollardPoints.push([x, pz0 + 0.85]);
  }
  for (let z = pz0 + 5.0; z <= pz1 - 5.0; z += step) {
    bollardPoints.push([px0 + 0.85, z]);
    bollardPoints.push([px1 - 0.85, z]);
  }

  for (const [bx, bz] of bollardPoints) {
    if (!isClearOfBuilding(bx, bz, 1.6)) continue;
    batcher.addCylinder('mullion', bx, 0.0, 0.76, bz, 0.065, 0.065, 12);
    batcher.addCylinder('emissiveWarm', bx, 0.76, 0.90, bz, 0.058, 0.058, 12);
    batcher.addCylinder('mullion', bx, 0.90, 0.96, bz, 0.072, 0.068, 12);
  }
}
