import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  type WheelEvent,
  type DragEvent,
} from "react";
import { cn } from "./_utils";

export interface MediaViewerProps {
  src: string;
  mimeType: string;
  alt?: string;
  className?: string;
  onError?: (err: Error) => void;
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/") && !mime.includes("svg");
}

function isVideo(mime: string): boolean {
  return mime.startsWith("video/");
}

function isAudio(mime: string): boolean {
  return mime.startsWith("audio/");
}

function isPdf(mime: string): boolean {
  return mime === "application/pdf";
}

function isGlb(mime: string): boolean {
  return (
    mime === "model/gltf-binary" ||
    mime === "model/gltf+json" ||
    mime === "model/vnd.gltf.draco" ||
    mime.includes("gltf") ||
    mime.includes("glb")
  );
}

// React 19 moved the JSX namespace under the `react` module (the global `JSX`
// namespace is no longer augmentable). Augment `React.JSX` so the
// `<model-viewer>` custom element types resolve under both React 18 and 19.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          alt?: string;
          "auto-rotate"?: string;
          "camera-controls"?: string;
          "environment-image"?: string;
          exposure?: string;
          "interaction-prompt"?: string;
          ref?: React.Ref<HTMLElement>;
        },
        HTMLElement
      >;
    }
  }
}

function ImageViewer({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => Math.max(0.1, Math.min(10, z + delta)));
    },
    [],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (zoom <= 1) return;
      setDragging(true);
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        px: position.x,
        py: position.y,
      };
    },
    [zoom, position],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPosition({
        x: dragStart.current.px + dx,
        y: dragStart.current.py + dy,
      });
    },
    [dragging],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (zoom > 1) {
      setZoom(1);
      setPosition({ x: 0, y: 0 });
    } else {
      setZoom(2);
    }
  }, [zoom]);

  return (
    <div
      className={cn(
        "relative overflow-hidden cursor-grab",
        dragging && "cursor-grabbing",
        className,
      )}
      style={{ width: "100%", height: "100%", minHeight: 300 }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      <img
        src={src}
        alt={alt ?? ""}
        draggable={false}
        style={{
          transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
          transformOrigin: "center center",
          transition: dragging ? "none" : "transform 0.2s ease-out",
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
        }}
        className="select-none pointer-events-none absolute inset-0 m-auto"
      />
      <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded">
        {Math.round(zoom * 100)}%
      </div>
    </div>
  );
}

function VideoPlayer({
  src,
  mimeType,
  className,
}: {
  src: string;
  mimeType: string;
  className?: string;
}) {
  return (
    <div className={cn("relative bg-black", className)}>
      <video
        src={src}
        controls
        className="w-full h-full max-h-[70vh]"
        preload="metadata"
      >
        <source src={src} type={mimeType} />
      </video>
    </div>
  );
}

function AudioPlayer({
  src,
  mimeType,
  className,
}: {
  src: string;
  mimeType: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center bg-gray-100 p-8 rounded-lg",
        className,
      )}
    >
      <audio src={src} controls className="w-full max-w-lg" preload="metadata">
        <source src={src} type={mimeType} />
      </audio>
    </div>
  );
}

function PdfViewer({
  src,
  className,
}: {
  src: string;
  className?: string;
}) {
  // Render the PDF inline with the browser's native viewer. NEVER route the
  // (authenticated, presigned) `src` through a third-party viewer like
  // docs.google.com — that would disclose the signed URL to Google. (§2.8)
  return (
    <div className={cn("relative w-full h-full min-h-[600px]", className)}>
      <object data={src} type="application/pdf" className="w-full h-full">
        <iframe src={src} className="w-full h-full border-0" title="PDF Viewer" />
      </object>
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute bottom-4 right-4 bg-blue-600 text-white px-3 py-1.5 rounded text-sm hover:bg-blue-700"
      >
        Open in new tab
      </a>
    </div>
  );
}

function ModelViewer({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);

  // Load model-viewer from the bundled, self-hosted package — never from a
  // third-party CDN. The old CDN <script> had no SRI and is blocked by the app's
  // `script-src 'self'` CSP anyway. Dynamic-importing in an effect keeps this
  // browser-only custom element out of SSR. (§2.9)
  useEffect(() => {
    let cancelled = false;
    void import("@google/model-viewer").catch((err) => {
      if (!cancelled) console.error("Failed to load 3D viewer:", err);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleError = () => {
      console.error("3D model failed to load:", src);
    };
    el.addEventListener("error", handleError);
    return () => el.removeEventListener("error", handleError);
  }, [src]);

  return (
    <div className={cn("w-full h-full min-h-[400px]", className)}>
      <model-viewer
        ref={ref}
        src={src}
        alt={alt ?? "3D model"}
        auto-rotate="true"
        camera-controls="true"
        environment-image="neutral"
        exposure="1"
        interaction-prompt="auto"
        style={{ width: "100%", height: "100%", minHeight: 400 }}
      />
    </div>
  );
}

function UnsupportedViewer({
  mimeType,
  className,
}: {
  mimeType: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center bg-gray-50 rounded-lg p-8 text-center min-h-[200px]",
        className,
      )}
    >
      <div className="text-4xl mb-3">📄</div>
      <p className="text-gray-600 font-medium">Preview not available</p>
      <p className="text-gray-400 text-sm mt-1">{mimeType}</p>
    </div>
  );
}

export function MediaViewer({
  src,
  mimeType,
  alt,
  className,
  onError,
}: MediaViewerProps) {
  try {
    if (isImage(mimeType)) {
      return <ImageViewer src={src} alt={alt} className={className} />;
    }
    if (isVideo(mimeType)) {
      return (
        <VideoPlayer src={src} mimeType={mimeType} className={className} />
      );
    }
    if (isAudio(mimeType)) {
      return (
        <AudioPlayer src={src} mimeType={mimeType} className={className} />
      );
    }
    if (isPdf(mimeType)) {
      return <PdfViewer src={src} className={className} />;
    }
    if (isGlb(mimeType)) {
      return <ModelViewer src={src} alt={alt} className={className} />;
    }
    return <UnsupportedViewer mimeType={mimeType} className={className} />;
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
    return (
      <div className="flex items-center justify-center bg-red-50 rounded-lg p-8 text-red-600">
        Failed to load media
      </div>
    );
  }
}
