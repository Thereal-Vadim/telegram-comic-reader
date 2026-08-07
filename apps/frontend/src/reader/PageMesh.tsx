import { useEffect, useMemo, useRef } from 'react';
import {
  Color,
  DoubleSide,
  PlaneGeometry,
  ShaderMaterial,
  Texture,
  type Mesh,
} from 'three';
import { pageFragmentShader, pageVertexShader } from './shaders';

/**
 * One sheet of paper.
 *
 * The mesh owns its geometry and material and disposes both on unmount.
 * Textures are *not* owned here: they belong to the TextureManager, and this
 * component only ever holds borrowed references. Disposing a texture from
 * inside a page component is exactly the bug that makes a shared texture go
 * black when an unrelated page unmounts.
 */

export interface PageMeshProps {
  /** Front face content. Null renders blank paper. */
  front: Texture | null;
  /** Back face content, shown once the sheet rotates past 90 degrees. */
  back: Texture | null;
  width: number;
  height: number;
  /** Segments across the fold axis. Only x is subdivided; y stays flat. */
  segments?: number;
  paperColor?: string;
  /** Draw order for overlapping sheets in the stack. */
  renderOrder?: number;
  visible?: boolean;
}

/**
 * 48 segments across the page.
 *
 * The bow is a quarter-sine, so faceting shows up as visible banding on the
 * curl below roughly 32 segments. Above about 64 there is no perceptible
 * improvement, and every segment is 2 extra vertices transformed per frame on
 * a GPU that is also decoding video elsewhere in the Telegram client. 48 sits
 * comfortably in the middle.
 */
const DEFAULT_SEGMENTS = 48;

export function usePageMaterial(paperColor: string): ShaderMaterial {
  return useMemo(() => {
    const material = new ShaderMaterial({
      vertexShader: pageVertexShader,
      fragmentShader: pageFragmentShader,
      // Both faces are drawn: the reverse of the sheet is a real surface here,
      // not a backface to be culled.
      side: DoubleSide,
      transparent: true,
      uniforms: {
        uProgress: { value: 0 },
        uWidth: { value: 1 },
        uBowAmount: { value: 0.12 },
        uTurnSign: { value: 1 },
        uFront: { value: null },
        uBack: { value: null },
        uHasFront: { value: 0 },
        uHasBack: { value: 0 },
        uPaperColor: { value: new Color(paperColor) },
        uOpacity: { value: 1 },
      },
    });
    return material;
    // Colour changes are pushed through the uniform below rather than by
    // rebuilding the material, which would recompile the shader.
  }, []);
}

export function PageMesh({
  front,
  back,
  width,
  height,
  segments = DEFAULT_SEGMENTS,
  paperColor = '#f8f5ef',
  renderOrder = 0,
  visible = true,
}: PageMeshProps): React.JSX.Element {
  const meshRef = useRef<Mesh>(null);
  const material = usePageMaterial(paperColor);

  const geometry = useMemo(
    // Height is never subdivided: the deformation is constant along y, so
    // extra rows would trans­form vertices that all move identically.
    () => new PlaneGeometry(width, height, segments, 1),
    [width, height, segments],
  );

  // Push texture changes straight into the uniforms. Assigning to a uniform
  // does not trigger a React render, which is the whole point: this can happen
  // mid-turn without disturbing the reconciler.
  useEffect(() => {
    material.uniforms['uFront']!.value = front;
    material.uniforms['uHasFront']!.value = front ? 1 : 0;
  }, [front, material]);

  useEffect(() => {
    material.uniforms['uBack']!.value = back;
    material.uniforms['uHasBack']!.value = back ? 1 : 0;
  }, [back, material]);

  useEffect(() => {
    material.uniforms['uWidth']!.value = width;
  }, [width, material]);

  useEffect(() => {
    (material.uniforms['uPaperColor']!.value as Color).set(paperColor);
  }, [paperColor, material]);

  // Geometry and material are per-instance, so they must be freed when the
  // sheet goes away. Textures are deliberately untouched here.
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh ref={meshRef} geometry={geometry} material={material} renderOrder={renderOrder} visible={visible} />
  );
}

/** Read/write access to a page's progress uniform from the render loop. */
export function setPageProgress(material: ShaderMaterial, progress: number): void {
  material.uniforms['uProgress']!.value = progress;
}

export function setPageOpacity(material: ShaderMaterial, opacity: number): void {
  material.uniforms['uOpacity']!.value = opacity;
}
