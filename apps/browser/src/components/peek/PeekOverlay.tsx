import { breadcrumb } from "@ardia/core";
import { WindowBackdrop, ink, Panel, PeekStage, reduceMotion, reduceMotionKnown, type PeekStageHandle, type PeekStageState } from "../ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "../ui/theme";
import { useCardFrame } from "../window/cardFrame";
import { usePeekSplitFull, usePeeks } from "../../state/peek/hooks";
import { usePeekDonors } from "../../state/peek/donors";
import { useSettings, useTab } from "../../state/browser/hooks";
import type { Peek } from "../../state/peek/peek";
import { PEEK_SCRIM } from "./tokens";
import { PageLabel, SMALL_INSET, SMALL_WINDOW_FRAME, SMALL_WINDOW_RADIUS, SmallBar } from "../littleArdia/SmallChrome";
import { dismissPeek, finishPeek, openPeekAsTab, openPeekInSplit, promotePeekNow, registerPeekMotion } from "../../state/peek/actions";
import { notePinch } from "../../state/telemetry/usage";
import { notePeekDone, notePeekEntrance, notePeekInterrupt } from "../../state/telemetry/peekMotion";
import { peekGeometry } from "./peekGeometry";
import { usePeekPageTop } from "./usePeekPageTop";
import { SMALL_BAR_HEIGHT } from "../../state/windows/small";
import { switchOn } from "../../state/app/switches";

let generations = 0;

export function PeekOverlay({
  windowId,
  width,
  height,
  origin,
  fullscreen,
  page,
}: {
  windowId: string;
  width: number;
  height: number;
  origin: { x: number; y: number } | null;
  fullscreen: boolean;
  page: (tabId: string, sourceId: string, width: number) => ReactNode;
}) {
  const live = usePeeks((p) => p[windowId]);
  const donor = usePeekDonors((d) => d[windowId]);
  const last = useRef<Peek | null>(null);
  if (live) last.current = live;
  const peek = live ?? (donor && last.current?.tabId === donor.tabId ? last.current : null);
  if (!peek || width <= 0 || height <= 0) return null;
  return <PeekCard key={peek.tabId} windowId={windowId} peek={peek} donor={!live} width={width} height={height} origin={origin} fullscreen={fullscreen} page={page} />;
}

function PeekCard({
  windowId,
  peek,
  donor,
  width,
  height,
  origin,
  fullscreen,
  page,
}: {
  windowId: string;
  peek: Peek;
  donor: boolean;
  width: number;
  height: number;
  origin: { x: number; y: number } | null;
  fullscreen: boolean;
  page: (tabId: string, sourceId: string, width: number) => ReactNode;
}) {
  const theme = useTheme();
  const card = useCardFrame();
  const windowFrame = theme.dark ? SMALL_WINDOW_FRAME.dark : SMALL_WINDOW_FRAME.light;
  const [reduce, setReduce] = useState<boolean | null>(() => reduceMotion());
  const [generation] = useState(() => ++generations);
  const stage = useRef<PeekStageHandle>(null);
  const seen = useRef({ entered: false, interrupted: false, done: false });
  const gestures = useSettings((s) => s.littleWindowGestures);
  const [meshAllowed] = useState(() => switchOn("peekGenie"));
  const pageTop = usePeekPageTop(windowId, peek.tabId);
  const fromX = peek.from && origin ? peek.from.x - origin.x : null;
  const fromY = peek.from && origin ? peek.from.y - origin.y : null;
  const geometry = useMemo(
    () =>
      peekGeometry({
        width,
        height,
        pageTop,
        bar: SMALL_BAR_HEIGHT,
        inset: card.inset,
        restRadius: card.radius,
        paneRadius: card.radius,
        from: fromX === null || fromY === null ? null : { x: fromX, y: fromY },
        fullscreen,
      }),
    [width, height, pageTop, card.inset, card.radius, fromX, fromY, fullscreen],
  );

  useEffect(() => {
    if (reduce !== null) return;
    let live = true;
    void reduceMotionKnown.then((value) => live && setReduce(value));
    return () => void (live = false);
  }, []);

  const known = reduce !== null;
  useEffect(() => {
    if (!known) return;
    void stage.current?.begin(generation);
    return registerPeekMotion(windowId, {
      tabId: peek.tabId,
      close: () => stage.current?.close(generation) ?? Promise.resolve(false),
      promote: () => stage.current?.promote(generation) ?? Promise.resolve(false),
    });
  }, [known]);

  const onState = (state: PeekStageState) => {
    if (state.generation !== generation) return;
    if (state.phase === "entering" && !seen.current.entered) {
      seen.current.entered = true;
      notePeekEntrance(state.entrance, !!state.fallback && state.entrance !== "fade", state.readyTimedOut);
    }
    if (state.interrupted && !seen.current.interrupted) {
      seen.current.interrupted = true;
      notePeekInterrupt();
    }
  };

  const cardRect = geometry.card;
  const pageRect = geometry.page;
  return (
    <PeekStage
      ref={stage}
      geometry={geometry}
      reduceMotion={!!reduce}
      gestures={!fullscreen && gestures}
      meshAllowed={meshAllowed}
      style={StyleSheet.absoluteFill}
      onPeekState={onState}
      onPeekPinch={({ generation: g, outcome }) => g === generation && outcome !== "stay" && notePinch("peek", outcome)}
      onPeekDone={({ generation: g, outcome }) => {
        if (g !== generation || seen.current.done) return;
        seen.current.done = true;
        notePeekDone(outcome);
        if (outcome === "closed") finishPeek(windowId, peek.tabId);
        else promotePeekNow(windowId, peek.tabId);
      }}
    >
      <View collapsable={false} style={StyleSheet.absoluteFill}>
        <Pressable
          accessibilityLabel="Close Peek"
          onPress={() => dismissPeek(windowId)}
          style={{ flex: 1, borderRadius: card.radius, backgroundColor: theme.dark ? PEEK_SCRIM.dark : PEEK_SCRIM.light }}
        />
      </View>
      <View collapsable={false} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <View style={{ position: "absolute", left: cardRect.x, top: cardRect.y, width: cardRect.width, height: cardRect.height }}>
          <Panel
            radius={SMALL_WINDOW_RADIUS}
            border={null}
            shadow={{ color: ink.black, opacity: windowFrame.shadowOpacity, radius: windowFrame.shadowRadius, offset: windowFrame.shadowOffset }}
            style={StyleSheet.absoluteFill}
          />
          <View style={{ flex: 1, borderRadius: SMALL_WINDOW_RADIUS, overflow: "hidden" }}>
            <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
            <PeekBar windowId={windowId} tabId={peek.tabId} />
          </View>
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: SMALL_WINDOW_RADIUS, borderWidth: StyleSheet.hairlineWidth, borderColor: windowFrame.innerRim }]} />
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: -StyleSheet.hairlineWidth,
              top: -StyleSheet.hairlineWidth,
              right: -StyleSheet.hairlineWidth,
              bottom: -StyleSheet.hairlineWidth,
              borderRadius: SMALL_WINDOW_RADIUS + StyleSheet.hairlineWidth,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: windowFrame.outerRim,
            }}
          />
        </View>
      </View>
      <View collapsable={false} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <View style={{ position: "absolute", left: pageRect.x, top: pageRect.y, width: pageRect.width, height: pageRect.height, backgroundColor: donor ? undefined : theme.card }}>
          {page(peek.tabId, peek.sourceId, pageRect.width)}
        </View>
      </View>
    </PeekStage>
  );
}

function PeekBar({ windowId, tabId }: { windowId: string; tabId: string }) {
  const tab = useTab(tabId);
  const splitFull = usePeekSplitFull(windowId);
  if (!tab) return null;
  const host = tab.url ? breadcrumb(tab.url).host : "";
  return (
    <SmallBar
      fieldLeft={SMALL_INSET}
      field={<PageLabel tab={tab} label={host ? `Peek: ${host}` : "Peek"} />}
      buttons={[
        { icon: "rectangle.split.2x1", disabled: splitFull, tooltip: "Open in Split View", onPress: () => openPeekInSplit(windowId) },
        { icon: "arrow.up.left.and.arrow.down.right", tooltip: "Open as Tab (⌘O)", onPress: () => openPeekAsTab(windowId) },
        { icon: "xmark", tooltip: "Close (Esc)", onPress: () => dismissPeek(windowId) },
      ]}
    />
  );
}
