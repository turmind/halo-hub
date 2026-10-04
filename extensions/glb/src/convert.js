// Build input for convert.min.js (see fetch-deps.sh; excluded from the release zip).
// Turns .obj / .stl bytes into an in-memory GLB so the one <model-viewer> can show every format.
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial, Color, DoubleSide, Scene } from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

// Crease-angle smoothing welds vertices through a string hash (~1 µs/triangle); past this, fall back to flat facets.
const SMOOTH_MAX_TRIANGLES = 400000;

// Smooth normals, but keep edges sharper than 30°. The welding hash in toCreasedNormals has a fixed 0.01-unit cell, so
// hand it a copy of the positions scaled to ~1000 units: the result is independent of the model's units (mm vs m).
function creasedNormals(g) {
  g.computeBoundingBox();
  const size = Math.max(...g.boundingBox.getSize(g.boundingBox.min.clone()).toArray());
  const k = size > 0 ? 1000 / size : 1;
  const scaled = new BufferGeometry();
  scaled.setAttribute('position', new Float32BufferAttribute(g.attributes.position.array.map((v) => v * k), 3));
  g.setAttribute('normal', toCreasedNormals(scaled, Math.PI / 6).attributes.normal);
}

export async function toGlb(kind, buffer) {
  const geometries = [];
  let ownNormals = false;
  if (kind === 'stl') {
    let g;
    try { g = new STLLoader().parse(buffer); } catch { throw new Error('Not a valid .stl file'); } // loader throws bare DataView RangeErrors
    g.rotateX(-Math.PI / 2); // STL is Z-up (CAD / 3D printing); glTF and model-viewer are Y-up
    geometries.push(g);
  } else {
    const text = new TextDecoder().decode(buffer);
    ownNormals = /^vn\s/m.test(text);
    new OBJLoader().parse(text).traverse((o) => { if (o.isMesh) geometries.push(o.geometry); });
  }
  const scene = new Scene();
  for (const g of geometries) {
    if (g.attributes.position.count === 0) continue;
    // Both loaders yield non-indexed triangles. STL normals are per-facet (often zero); OBJLoader silently substitutes
    // flat face normals when the file has no `vn` lines. Rebuild smooth ones unless the file brought its own.
    if (!ownNormals) {
      g.deleteAttribute('normal');
      if (g.attributes.position.count / 3 <= SMOOTH_MAX_TRIANGLES) creasedNormals(g);
      else g.computeVertexNormals();
    }
    // Neutral grey (white when the file carries vertex colors, which multiply it), exported as glTF metallic-roughness.
    // DoubleSide keeps open or inverted shells visible.
    const colored = !!g.attributes.color;
    scene.add(new Mesh(g, new MeshStandardMaterial({
      color: new Color(colored ? 0xffffff : 0xb4b8c0), roughness: 0.55, metalness: 0, side: DoubleSide, vertexColors: colored,
    })));
  }
  if (scene.children.length === 0) throw new Error(`No mesh geometry found in this .${kind} file`);
  return new GLTFExporter().parseAsync(scene, { binary: true });
}
