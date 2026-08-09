export interface WebGlDiagnostics {
  supported: boolean;
  context: "webgl2" | "webgl" | null;
  renderer: string;
  vendor: string;
  maskedRenderer: string;
  maskedVendor: string;
  version: string;
  shadingLanguageVersion: string;
  debugRendererInfoAvailable: boolean;
  software: boolean;
  reason: string | null;
}

export interface FrontendDiagnostics {
  userAgent: string;
  language: string;
  languages: string[];
  platform: string;
  devicePixelRatio: number;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
  };
  webgl: WebGlDiagnostics;
}

export function isSoftwareRendererName(renderer: string): boolean {
  return /swiftshader|software|basic render|llvmpipe|lavapipe/i.test(renderer);
}

export function probeWebGL(): WebGlDiagnostics {
  const empty: WebGlDiagnostics = {
    supported: false,
    context: null,
    renderer: "",
    vendor: "",
    maskedRenderer: "",
    maskedVendor: "",
    version: "",
    shadingLanguageVersion: "",
    debugRendererInfoAvailable: false,
    software: true,
    reason: "context-unavailable",
  };
  try {
    const canvas = document.createElement("canvas");
    const webgl2 = canvas.getContext("webgl2");
    const gl = (webgl2 ?? canvas.getContext("webgl")) as
      | WebGLRenderingContext
      | WebGL2RenderingContext
      | null;
    if (!gl) return empty;
    const ext = gl.getExtension("WEBGL_debug_renderer_info") as
      | {
          UNMASKED_RENDERER_WEBGL: number;
          UNMASKED_VENDOR_WEBGL: number;
        }
      | null;
    const renderer = String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "",
    );
    const vendor = String(
      ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : "",
    );
    const software = !ext || !renderer || isSoftwareRendererName(renderer);
    const result: WebGlDiagnostics = {
      supported: true,
      context: webgl2 ? "webgl2" : "webgl",
      renderer,
      vendor,
      maskedRenderer: String(gl.getParameter(gl.RENDERER) ?? ""),
      maskedVendor: String(gl.getParameter(gl.VENDOR) ?? ""),
      version: String(gl.getParameter(gl.VERSION) ?? ""),
      shadingLanguageVersion: String(
        gl.getParameter(gl.SHADING_LANGUAGE_VERSION) ?? "",
      ),
      debugRendererInfoAvailable: !!ext,
      software,
      reason: !ext
        ? "renderer-info-unavailable"
        : !renderer
          ? "renderer-empty"
          : software
            ? "software-renderer"
            : null,
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
  } catch {
    return { ...empty, reason: "probe-failed" };
  }
}

/** 探针拿不到明确的硬件 renderer 时保守回退 canvas，避免安装版软件 WebGL 持续闪烁。 */
export function isSoftwareWebGL(): boolean {
  const result = probeWebGL();
  return !result.supported || result.software;
}

export function collectFrontendDiagnostics(): FrontendDiagnostics {
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: [...navigator.languages],
    platform: navigator.platform,
    devicePixelRatio: window.devicePixelRatio,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight,
      colorDepth: window.screen.colorDepth,
      pixelDepth: window.screen.pixelDepth,
    },
    webgl: probeWebGL(),
  };
}
