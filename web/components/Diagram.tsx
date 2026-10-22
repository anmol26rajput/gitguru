"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { dotTiming, litAnimation, litKeyframes } from "@/lib/diagramAnim";
import { MAX_ZOOM, MIN_ZOOM, clampZoom, fitZoom, scrollShift, stepZoom, wheelZoom } from "@/lib/zoom";
import ErrorBox, { fail, type Failure } from "./ErrorBox";
import { Key } from "./ui";

type Overview = {
  summary: string;
  flow_mermaid: string;
  how_it_works: { label: string; detail: string }[];
  parts: { name: string; path: string; what: string }[];
  glossary: { term: string; meaning: string }[];
};
type Data = { mermaid: string; overview: Overview };
let renderCount = 0; // mermaid needs a unique element id per render

type FsDoc = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
const PAD = 32; // the diagram box's p-4 on both sides

const SVG_NS = "http://www.w3.org/2000/svg";

// Mermaid's "base" theme from the design tokens of the current colour scheme (read at render time).
function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    darkMode: window.matchMedia("(prefers-color-scheme: dark)").matches,
    background: v("--diagram-pane"),
    mainBkg: v("--surface"),
    primaryColor: v("--surface"),
    nodeBorder: v("--border"),
    primaryBorderColor: v("--border"),
    lineColor: v("--accent"),
    primaryTextColor: v("--text"),
    textColor: v("--text"),
    fontFamily: getComputedStyle(document.body).fontFamily,
  };
}

function make(tag: string, attrs: Record<string, string>) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Motion added to the rendered SVG (the caller skips it under reduced motion; CSS cannot stop the SMIL dots).
// Every edge gets marching dashes. For the step flow (`steps`), each step lights up in turn and one dot per
// edge runs along it, handing over from edge to edge (the flow is a chain: edge i joins step i to step i+1).
function animate(svg: SVGSVGElement, id: string, steps: boolean) {
  const edges = [...svg.querySelectorAll<SVGPathElement>("path.flowchart-link")];
  edges.forEach((p) => p.classList.add("diagram-flow"));
  if (!steps) return;
  const shapes = [...svg.querySelectorAll(".node")]
    .map((n) => n.querySelector<SVGElement>("rect, polygon, path"))
    .filter((s) => s !== null);
  const n = shapes.length;
  if (!n) return;
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = litKeyframes(n);
  svg.prepend(style);
  shapes.forEach((s, i) => {
    s.classList.add("diagram-step");
    s.style.animation = litAnimation(n, i);
  });
  edges.forEach((p, i) => {
    p.id = `${id}-edge-${i}`;
    const t = dotTiming(n, i);
    const loop = { begin: t.begin, dur: t.dur, repeatCount: "indefinite" };
    const move = make("animateMotion", { ...loop, calcMode: "linear", keyPoints: "0;1;1", keyTimes: `0;${t.move};1` });
    move.append(make("mpath", { href: `#${p.id}` }));
    const show = make("animate", { ...loop, attributeName: "opacity", calcMode: "discrete", values: "1;0", keyTimes: `0;${t.move}` });
    const dot = make("circle", { r: "5", class: "diagram-dot", opacity: "0" });
    dot.append(move, show);
    p.after(dot);
  });
  svg.setCurrentTime(0); // SMIL runs on the page's clock from load; restart it so the dots start with the CSS light-up
}

// Renders Mermaid source (strict mode) into a zoomable, pannable box with zoom / fit / full screen buttons.
// `steps`: this is the step-by-step flow, so it also gets the light-up and travelling-dot animation.
function MermaidView({ code, label, steps = false, onError }: { code: string; label: string; steps?: boolean; onError: (e: Failure) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const natural = useRef<{ w: number; h: number } | null>(null); // the SVG's own size (viewBox) at 100%
  const zoomNow = useRef(1);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [zoom, setZoomState] = useState(1);
  const [fsOk, setFsOk] = useState(false);
  const [fs, setFs] = useState(false);

  // Resize the SVG to natural size x zoom (real width/height, not a CSS transform, so text stays crisp) and keep the
  // diagram point under (px, py) (viewport coordinates) where it was; no pointer = keep the viewer's centre.
  const setZoom = useCallback((z: number, px?: number, py?: number) => {
    const sc = scroller.current;
    const svg = box.current?.querySelector("svg");
    const n = natural.current;
    if (!sc || !svg || !n) return;
    z = clampZoom(z);
    const r = sc.getBoundingClientRect();
    px ??= r.left + sc.clientWidth / 2;
    py ??= r.top + sc.clientHeight / 2;
    const before = svg.getBoundingClientRect();
    svg.setAttribute("width", String(n.w * z));
    svg.setAttribute("height", String(n.h * z));
    const after = svg.getBoundingClientRect();
    const ratio = z / zoomNow.current;
    sc.scrollLeft += scrollShift(px, before.left, after.left, ratio);
    sc.scrollTop += scrollShift(py, before.top, after.top, ratio);
    zoomNow.current = z;
    setZoomState(z);
  }, []);

  const fit = useCallback(() => {
    const sc = scroller.current;
    const n = natural.current;
    if (!sc || !n) return;
    setZoom(fitZoom(sc.clientWidth - PAD, n.w));
    sc.scrollTo(0, 0);
  }, [setZoom]);

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const m = (await import("mermaid")).default;
        m.initialize({ startOnLoad: false, securityLevel: "strict", look: "classic", theme: "base", themeVariables: themeVariables(), flowchart: { useMaxWidth: false } });
        const id = `repo-diagram-${++renderCount}`;
        const { svg } = await m.render(id, code);
        if (stale || !box.current) return;
        box.current.innerHTML = svg; // svg is sanitized by mermaid's strict mode
        const el = box.current.querySelector("svg");
        const vb = el?.viewBox.baseVal;
        if (el && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) animate(el, id, steps);
        if (!el || !vb || !vb.width || !vb.height) return; // no size to scale from: show it as Mermaid drew it
        el.style.maxWidth = "none";
        natural.current = { w: vb.width, h: vb.height };
        zoomNow.current = 1;
        fit(); // every diagram starts at Fit
      } catch (e) {
        if (!stale) onError(fail(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [code, steps, onError, fit]);

  // Ctrl/⌘ + wheel (a trackpad pinch arrives as ctrl+wheel) zooms around the pointer. Needs a non-passive listener,
  // which React's onWheel is not, so preventDefault (stop the page zooming) would be ignored there.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(wheelZoom(zoomNow.current, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY), e.clientX, e.clientY);
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  // Full screen: hidden where the browser has no Fullscreen API (Safari used a webkit prefix).
  useEffect(() => {
    const d = document as FsDoc;
    const on = () => {
      setFs((d.fullscreenElement ?? d.webkitFullscreenElement) === wrap.current);
    };
    setFsOk(!!(d.fullscreenEnabled || d.webkitFullscreenEnabled)); // eslint-disable-line react-hooks/set-state-in-effect
    document.addEventListener("fullscreenchange", on);
    document.addEventListener("webkitfullscreenchange", on);
    return () => {
      document.removeEventListener("fullscreenchange", on);
      document.removeEventListener("webkitfullscreenchange", on);
    };
  }, []);

  // Refit once React has applied this viewer's full-screen classes (only the viewer whose `fs` changed runs this).
  useLayoutEffect(() => {
    fit();
  }, [fs, fit]);

  function toggleFs() {
    const d = document as FsDoc;
    const el = wrap.current as FsEl | null;
    if (d.fullscreenElement ?? d.webkitFullscreenElement) (d.exitFullscreen ?? d.webkitExitFullscreen)?.call(d);
    else (el?.requestFullscreen ?? el?.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") setZoom(stepZoom(zoomNow.current, 1));
    else if (e.key === "-" || e.key === "_") setZoom(stepZoom(zoomNow.current, -1));
    else if (e.key === "0") fit();
    else return;
    e.preventDefault();
  }

  // Drag to pan with a mouse (touch already scrolls natively).
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const sc = e.currentTarget;
    const r = sc.getBoundingClientRect();
    if (e.clientX > r.left + sc.clientLeft + sc.clientWidth || e.clientY > r.top + sc.clientTop + sc.clientHeight) return; // a scrollbar press
    drag.current = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
    sc.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    e.currentTarget.scrollLeft = d.left - (e.clientX - d.x);
    e.currentTarget.scrollTop = d.top - (e.clientY - d.y);
  }
  const endDrag = () => (drag.current = null);

  return (
    <div
      ref={wrap}
      role="group"
      aria-label={`${label} viewer`}
      onKeyDown={onKeyDown}
      className={fs ? "flex h-screen flex-col gap-3 bg-bg p-4 text-text" : "space-y-3"}
    >
      <div className="flex flex-wrap items-center gap-2 font-mono">
        <Key variant="ghost" size="sm" aria-label="Zoom out" onClick={() => setZoom(stepZoom(zoomNow.current, -1))} disabled={zoom <= MIN_ZOOM}>
          −
        </Key>
        <span className="min-w-11 text-center text-xs tabular-nums text-muted" data-testid="zoom-percent">
          {Math.round(zoom * 100)}%
        </span>
        <Key variant="ghost" size="sm" aria-label="Zoom in" onClick={() => setZoom(stepZoom(zoomNow.current, 1))} disabled={zoom >= MAX_ZOOM}>
          +
        </Key>
        <Key variant="ghost" size="sm" onClick={fit}>
          Fit
        </Key>
        {fsOk && (
          <Key variant="ghost" size="sm" className="ml-auto" onClick={toggleFs}>
            {fs ? "Exit full screen" : "Full screen"}
          </Key>
        )}
      </div>
      <div
        ref={scroller}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`cursor-grab select-none overflow-auto rounded-card border border-border bg-diagram-pane active:cursor-grabbing ${fs ? "min-h-0 flex-1" : "max-h-[70vh]"}`}
      >
        <div ref={box} role="img" aria-label={label} className={`diagram mx-auto w-max p-4 ${steps ? "" : "diagram-modules"}`} />
      </div>
    </div>
  );
}

export default function Diagram({ repoId }: { repoId: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<Failure | null>(null);

  useEffect(() => {
    let stale = false;
    api(`/repos/${repoId}/diagram`)
      .then((r) => r.json())
      .then((d: Data) => !stale && setData(d))
      .catch((e) => !stale && setError(fail(e)));
    return () => {
      stale = true;
    };
  }, [repoId]);

  const o = data?.overview;
  return (
    <main className="mx-auto w-full max-w-[760px] min-w-0 flex-1 space-y-10 px-6 pt-6 pb-12">
      {error && <ErrorBox error={error} />}
      {!data && !error && <p className="text-muted">Building the overview… (the first time takes a few seconds)</p>}
      {data && o && (
        <>
          <section className="space-y-2">
            <h2 className="section-label">What it does</h2>
            <p>{o.summary}</p>
          </section>

          <section className="space-y-3">
            <h2 className="section-label">How it works</h2>
            {o.flow_mermaid && <MermaidView code={o.flow_mermaid} label="How it works diagram" steps onError={setError} />}
            <ol className="ml-5 list-decimal space-y-1">
              {o.how_it_works.map((s, i) => (
                <li key={i}>
                  <span className="font-medium">{s.label}:</span> {s.detail}
                </li>
              ))}
            </ol>
          </section>

          <section className="space-y-3">
            <h2 className="section-label">The main parts</h2>
            {data.mermaid ? (
              <MermaidView code={data.mermaid} label="Module dependency diagram" onError={setError} />
            ) : (
              <p className="text-muted">No internal imports found — the parts below still describe the repo.</p>
            )}
            <ul className="space-y-2">
              {o.parts.map((p, i) => (
                <li key={i}>
                  <span className="font-medium">{p.name}:</span> {p.what}{" "}
                  <span className="font-mono text-xs text-muted">{p.path}</span>
                </li>
              ))}
            </ul>
          </section>

          {o.glossary.length > 0 && (
            <section className="space-y-2">
              <h2 className="section-label">Key words</h2>
              <dl className="space-y-2">
                {o.glossary.map((g, i) => (
                  <div key={i}>
                    <dt className="font-medium">{g.term}</dt>
                    <dd className="text-muted">{g.meaning}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      )}
    </main>
  );
}
