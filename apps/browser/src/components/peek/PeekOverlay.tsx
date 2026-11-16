import { breadcrumb } from "@ardia/core";
import { WindowBackdrop, ink, PageCoverGate, Panel, PeekStage, reduceMotion, reduceMotionKnown, type PeekStageHandle, type PeekStageState } from "../ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "../ui/theme";
import { useCardFrame } from "../window/cardFrame";
import { usePeekSplitFull, useWindowPeeks } from "../../state/peek/hooks";
import { usePeekDonors } from "../../state/peek/donors";
import { useActiveTabId, useTab } from "../../state/browser/hooks";
import { useFullscreenTab } from "../../state/tabs/pageState";
import type { Peek } from "../../state/peek/peek";
import { PEEK_SCRIM } from "./tokens";
import { PageLabel, SMALL_INSET, SMALL_WINDOW_FRAME, SmallBar, smallWindowRadius, type SmallBarButton } from "../littleArdia/SmallChrome";
import { dismissPeek, finishPeek, openPeekAsTab, openPeekInSplit, promotePeekNow, registerPeekMotion } from "../../state/peek/actions";
import { keyText } from "../../state/commands/keyText";
import { splitViewAvailable } from "../../state/splits/splits";
import { notePinch } from "../../state/telemetry/usage";
import { notePeekDone, notePeekEntrance, notePeekInterrupt } from "../../state/telemetry/peekMotion";
import { peekGeometry, type PeekRect } from "./peekGeometry";
import { usePeekPageTop } from "./usePeekPageTop";
import { SMALL_BAR_HEIGHT } from "../../state/windows/small";
import { switchOn } from "../../state/app/switches";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { endPeekToolbarPreview, previewPeekToolbar } from "../../state/peek/toolbarPreview";

let generations = 0;

function peekButtonList(windowId: string, splitFull: boolean): SmallBarButton[] {
  return [
    ...(splitViewAvailable ? [{ icon: "rectangle.split.2x1", disabled: splitFull, tooltip: "Open in Split View", onPress: () => openPeekInSplit(windowId) }] : []),
    { icon: "arrow.up.left.and.arrow.down.right", tooltip: `Open as Tab (${keyText("⌘O")})`, onPress: () => openPeekAsTab(windowId) },
    { icon: "xmark", tooltip: "Close (Esc)", onPress: () => dismissPeek(windowId) },
  ];
}

export function PeekOverlay({
  windowId,
  width,
  height,
  origin,
  page,
}: {
  windowId: string;
  width: number;
  height: number;
  origin: { x: number; y: number } | null;
  page: (tabId: string, sourceId: string, width: number, shown: boolean, fullscreen: boolean) => ReactNode;
}) {
  const peeks = useWindowPeeks(windowId);
  const activeTabId = useActiveTabId();
  const fullscreenTabId = useFullscreenTab(windowId);
  const donor = usePeekDonors((d) => d[windowId]);
  const known = useRef(new Map<string, Peek>());
  const listed = new Map<string, Peek>();
  for (const peek of peeks) listed.set(peek.tabId, peek);
  const donated = donor && !listed.has(donor.tabId) ? known.current.get(donor.tabId) : undefined;
  if (donated) listed.set(donated.tabId, donated);
  known.current = listed;
  if (!listed.size || width <= 0 || height <= 0) return null;
  return [...listed.values()].map((peek) => {
    const fullscreen = fullscreenTabId === peek.tabId;
    const isDonor = peek === donated;
    return (
      <PeekCard
        key={peek.tabId}
        windowId={windowId}
        peek={peek}
        donor={isDonor}
        shown={isDonor || (peek.sourceId === activeTabId && (!fullscreenTabId || fullscreen))}
        width={width}
        height={height}
        origin={origin}
        fullscreen={fullscreen}
        page={page}
      />
    );
  });
}

function PeekCard({
  windowId,
  peek,
  donor,
  shown,
  width,
  height,
  origin,
  fullscreen,
  page,
}: {
  windowId: string;
  peek: Peek;
  donor: boolean;
  shown: boolean;
  width: number;
  height: number;
  origin: { x: number; y: number } | null;
  fullscreen: boolean;
  page: (tabId: string, sourceId: string, width: number, shown: boolean, fullscreen: boolean) => ReactNode;
}) {
  const theme = useTheme();
  const card = useCardFrame();
  const [reduce, setReduce] = useState<boolean | null>(() => reduceMotion());
  const [generation] = useState(() => ++generations);
  const stage = useRef<PeekStageHandle>(null);
  const seen = useRef({ entered: false, interrupted: false, done: false });
  const openedBefore = useRef(!shown);
  const begun = useRef(false);
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
        pageAtTabSize: PLATFORM_FEATURES.nativePeekMotion,
      }),
    [width, height, pageTop, card.inset, card.radius, fromX, fromY, fullscreen],
  );

  useEffect(() => {
    if (reduce !== null) return;
    let live = true;
    void reduceMotionKnown.then((value) => live && setReduce(value));
    return () => void (live = false);
  }, []);

  useEffect(() => () => endPeekToolbarPreview(windowId, peek.tabId), []);

  const known = reduce !== null;
  useEffect(() => {
    if (!known || !shown || donor) return;
    if (!begun.current) {
      begun.current = true;
      void stage.current?.begin(generation, !openedBefore.current);
    }
    return registerPeekMotion(windowId, {
      tabId: peek.tabId,
      close: () => stage.current?.close(generation) ?? Promise.resolve(false),
      promote: () => stage.current?.promote(generation) ?? Promise.resolve(false),
    });
  }, [known, shown]);

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
    <PageCoverGate covering={shown}>
      <View style={[StyleSheet.absoluteFill, !shown && { opacity: 0 }]} pointerEvents={known && shown ? "box-none" : "none"}>
        <PeekStage
          ref={stage}
          geometry={geometry}
          reduceMotion={!!reduce}
          gestures={shown && !donor && !fullscreen}
          meshAllowed={meshAllowed}
          style={StyleSheet.absoluteFill}
          onPeekState={onState}
          onPeekPinch={({ generation: g, outcome }) => {
            if (g !== generation || outcome === "stay") return;
            if (outcome === "open") previewPeekToolbar(windowId, peek.tabId, peek.sourceId);
            notePinch("peek", outcome);
          }}
          onPeekDone={({ generation: g, outcome }) => {
            if (g !== generation || seen.current.done) return;
            seen.current.done = true;
            notePeekDone(outcome);
            if (outcome === "closed") finishPeek(peek.tabId);
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
          <PeekCardChrome windowId={windowId} tabId={peek.tabId} rect={cardRect} browserRadius={card.radius} />
          <PeekPageLayer rect={pageRect} background={donor ? undefined : theme.card} browserRadius={card.radius}>
            {page(peek.tabId, peek.sourceId, pageRect.width, shown, fullscreen)}
          </PeekPageLayer>
        </PeekStage>
      </View>
    </PageCoverGate>
  );
}

type PeekZoom = { toTab: Animated.Value; grown: Animated.AnimatedInterpolation<number> };

function PeekCardChrome({ windowId, tabId, rect, browserRadius, zoom }: { windowId: string; tabId: string; rect: PeekRect; browserRadius: number; zoom?: PeekZoom }) {
  const theme = useTheme();
  const windowFrame = theme.dark ? SMALL_WINDOW_FRAME.dark : SMALL_WINDOW_FRAME.light;
  const radius = smallWindowRadius();
  const corner = zoom ? Animated.divide(zoom.toTab.interpolate({ inputRange: [0, 1], outputRange: [radius, browserRadius] }), zoom.grown) : radius;
  const rim = zoom ? Animated.add(corner, StyleSheet.hairlineWidth) : radius + StyleSheet.hairlineWidth;
  return (
    <View collapsable={false} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <View style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
        <Panel
          radius={radius}
          border={null}
          shadow={{ color: ink.black, opacity: windowFrame.shadowOpacity, radius: windowFrame.shadowRadius, offset: windowFrame.shadowOffset }}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View style={{ flex: 1, borderRadius: corner, overflow: "hidden" }}>
          <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
          <PeekBar windowId={windowId} tabId={tabId} />
        </Animated.View>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: corner, borderWidth: StyleSheet.hairlineWidth, borderColor: windowFrame.innerRim }]} />
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: -StyleSheet.hairlineWidth,
            top: -StyleSheet.hairlineWidth,
            right: -StyleSheet.hairlineWidth,
            bottom: -StyleSheet.hairlineWidth,
            borderRadius: rim,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: windowFrame.outerRim,
          }}
        />
      </View>
    </View>
  );
}

function PeekPageLayer({ rect, background, browserRadius, zoom, children }: { rect: PeekRect; background: string | undefined; browserRadius: number; zoom?: PeekZoom; children: ReactNode }) {
  return (
    <View collapsable={false} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View
        style={[
          { position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height, backgroundColor: background },
          zoom && { borderRadius: Animated.divide(browserRadius, zoom.grown), overflow: "hidden" },
        ]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

function PeekBar({ windowId, tabId }: { windowId: string; tabId: string }) {
  const tab = useTab(tabId);
  const splitFull = usePeekSplitFull(windowId);
  if (!tab) return null;
  const host = tab.url ? breadcrumb(tab.url).host : "";
  return <SmallBar fieldLeft={SMALL_INSET} field={<PageLabel tab={tab} label={host ? `Peek: ${host}` : "Peek"} />} buttons={peekButtonList(windowId, splitFull)} />;
}
